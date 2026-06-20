import copy
import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SUMMARY_PATH = ROOT / "data/summary.json"
PROJECT_ID = "etf"


def _matches_type(value, expected_type):
    if expected_type == "object":
        return isinstance(value, dict)
    if expected_type == "array":
        return isinstance(value, list)
    if expected_type == "string":
        return isinstance(value, str)
    if expected_type == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    return True


def _validate_json_schema(schema, value, path="$"):
    errors = []
    expected_type = schema.get("type")
    if expected_type and not _matches_type(value, expected_type):
        return [f"{path}: expected {expected_type}, got {type(value).__name__}"]
    if "const" in schema and value != schema["const"]:
        errors.append(f"{path}: expected const {schema['const']!r}, got {value!r}")
    if "enum" in schema and value not in schema["enum"]:
        errors.append(f"{path}: expected one of {schema['enum']!r}, got {value!r}")
    if isinstance(value, str) and len(value) < schema.get("minLength", 0):
        errors.append(f"{path}: shorter than minLength {schema['minLength']}")
    if isinstance(value, (int, float)) and not isinstance(value, bool) and "exclusiveMinimum" in schema:
        if not value > schema["exclusiveMinimum"]:
            errors.append(f"{path}: expected > {schema['exclusiveMinimum']}, got {value}")
    if isinstance(value, list):
        if len(value) < schema.get("minItems", 0):
            errors.append(f"{path}: fewer than minItems {schema['minItems']}")
        item_schema = schema.get("items")
        if item_schema:
            for index, item in enumerate(value):
                errors.extend(_validate_json_schema(item_schema, item, f"{path}[{index}]"))
    if isinstance(value, dict):
        if len(value) < schema.get("minProperties", 0):
            errors.append(f"{path}: fewer than minProperties {schema['minProperties']}")
        for key in schema.get("required", []):
            if key not in value:
                errors.append(f"{path}: missing required key {key!r}")
        for key, property_schema in schema.get("properties", {}).items():
            if key in value:
                errors.extend(_validate_json_schema(property_schema, value[key], f"{path}.{key}"))
    return errors


class SummaryContractSchemaTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.schema = json.loads((ROOT / "contracts" / "quant-research-summary.v1.schema.json").read_text(encoding="utf-8"))
        cls.summary = json.loads(SUMMARY_PATH.read_text(encoding="utf-8"))
        cls.rules = cls.schema["x-contractRules"]

    def test_public_summary_validates_against_shared_json_schema(self):
        errors = _validate_json_schema(self.schema, self.summary)
        self.assertEqual(errors, [], "shared schema validation errors: " + "; ".join(errors))

    def test_shared_schema_rejects_legacy_string_highlights(self):
        legacy = copy.deepcopy(self.summary)
        legacy["highlights"] = ["legacy string highlight"]
        errors = _validate_json_schema(self.schema, legacy)
        self.assertTrue(any("highlights[0]" in error and "expected object" in error for error in errors), errors)

    def test_contract_core_semantics_match_shared_schema(self):
        missing = [key for key in self.rules["requiredTopLevelKeys"] if key not in self.summary]
        self.assertEqual(missing, [], f"summary missing shared contract keys: {missing}")
        self.assertEqual(self.summary["contract"], self.rules["summaryContract"])
        self.assertEqual(self.summary["schemaVersion"], self.rules["schemaVersion"])
        self.assertEqual(self.summary["projectId"], PROJECT_ID)
        for key in self.rules["arrayKeys"]:
            self.assertIsInstance(self.summary[key], list, key)
            self.assertGreater(len(self.summary[key]), 0, key)
        for key in self.rules["objectKeys"]:
            self.assertIsInstance(self.summary[key], dict, key)
            self.assertGreater(len(self.summary[key]), 0, key)

    def test_highlight_status_and_entity_semantics_are_dashboard_safe(self):
        for highlight in self.summary["highlights"]:
            missing_highlight = [key for key in self.rules["requiredHighlightKeys"] if key not in highlight]
            self.assertEqual(missing_highlight, [], f"highlight missing keys: {missing_highlight}")
            self.assertTrue(str(highlight["label"]).strip())
            self.assertTrue(str(highlight["description"]).strip())

        status = self.summary["status"]
        missing_status = [key for key in self.rules["requiredStatusKeys"] if key not in status]
        self.assertEqual(missing_status, [], f"status missing keys: {missing_status}")
        self.assertIn(status["state"], self.rules["allowedStatusStates"])
        self.assertIsInstance(status["label"], str)
        self.assertGreater(len(status["label"]), 1)
        self.assertIsInstance(status["cadence"], str)
        self.assertGreater(len(status["cadence"]), 1)
        self.assertGreater(float(status["expectedFreshnessDays"]), 0)
        if "degradedReasons" in status:
            self.assertIsInstance(status["degradedReasons"], list)

        for entity in self.summary["primaryEntities"]:
            missing_entity = [key for key in self.rules["requiredEntityKeys"] if key not in entity]
            self.assertEqual(missing_entity, [], f"entity missing keys: {missing_entity}")
            self.assertIsInstance(entity["metrics"], dict)
            for key in self.rules["entityArrayKeys"]:
                self.assertIsInstance(entity[key], list, key)
            self.assertTrue(str(entity["symbol"]).strip())
            self.assertTrue(str(entity["label"]).strip())


if __name__ == "__main__":
    unittest.main()
