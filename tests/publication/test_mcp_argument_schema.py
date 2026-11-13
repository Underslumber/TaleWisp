import importlib.util
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
PLUGIN = Path(os.environ.get('TALEWISP_TEST_PLUGIN_ROOT', ROOT / 'plugin'))

SCRIPT = PLUGIN / "scripts/talewisp_mcp.py"
SPEC = importlib.util.spec_from_file_location("talewisp_mcp_schema_test", SCRIPT)
mcp = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
sys.modules[SPEC.name] = mcp
SPEC.loader.exec_module(mcp)

TOOL = "talewisp_roleplay_turn"


def call(name, arguments):
    request = {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
               "params": {"name": name, "arguments": arguments}}
    return mcp.handle(request)


class McpArgumentSchemaTests(unittest.TestCase):
    def test_action_outside_enum_is_rejected_without_calling_handler(self):
        handler = mock.Mock(return_value={"ok": True})
        with mock.patch.dict(mcp.HANDLERS, {TOOL: handler}):
            response = call(TOOL, {"session_id": "s", "action": "start", "expected_revision": 1})
        result = response["result"]
        self.assertTrue(result["isError"])
        self.assertIn("action", result["content"][0]["text"])
        handler.assert_not_called()

    def test_missing_required_field_is_rejected(self):
        handler = mock.Mock(return_value={"ok": True})
        with mock.patch.dict(mcp.HANDLERS, {TOOL: handler}):
            response = call(TOOL, {"session_id": "s", "action": "pause"})
        result = response["result"]
        self.assertTrue(result["isError"])
        self.assertIn("expected_revision", result["content"][0]["text"])
        handler.assert_not_called()

    def test_non_object_arguments_are_rejected(self):
        handler = mock.Mock(return_value={"ok": True})
        with mock.patch.dict(mcp.HANDLERS, {TOOL: handler}):
            response = call(TOOL, ["situation"])
        self.assertTrue(response["result"]["isError"])
        handler.assert_not_called()

    def test_valid_call_reaches_handler(self):
        handler = mock.Mock(return_value={"ok": True})
        arguments = {"session_id": "s", "action": "pause", "expected_revision": 2}
        with mock.patch.dict(mcp.HANDLERS, {TOOL: handler}):
            response = call(TOOL, arguments)
        self.assertFalse(response["result"]["isError"])
        handler.assert_called_once_with(arguments)

    def test_required_fields_exist_in_properties(self):
        for tool in mcp.TOOLS:
            schema = tool.get("inputSchema") or {}
            properties = schema.get("properties") or {}
            for field in schema.get("required") or []:
                self.assertIn(field, properties, f"{tool['name']}: required {field} not in properties")


if __name__ == "__main__":
    unittest.main()
