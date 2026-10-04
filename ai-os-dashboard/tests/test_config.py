import unittest
from unittest import mock

from aios.config import Settings, resolve_provider


class ConfigTests(unittest.TestCase):
    def test_defaults_bind_loopback(self) -> None:
        s = Settings.from_env({"AIOS_PROVIDER": "mock"})
        self.assertEqual(s.host, "127.0.0.1")
        self.assertEqual(s.provider, "mock")
        self.assertIsNone(s.api_token)

    def test_auto_without_key_is_mock(self) -> None:
        self.assertEqual(resolve_provider("auto", {}), "mock")

    def test_auto_with_key_and_sdk_is_anthropic(self) -> None:
        with mock.patch("importlib.util.find_spec", return_value=object()):
            self.assertEqual(resolve_provider("auto", {"ANTHROPIC_API_KEY": "k"}), "anthropic")

    def test_auto_with_key_but_no_sdk_is_mock(self) -> None:
        with mock.patch("importlib.util.find_spec", return_value=None):
            self.assertEqual(resolve_provider("auto", {"ANTHROPIC_API_KEY": "k"}), "mock")

    def test_invalid_values_rejected(self) -> None:
        with self.assertRaises(ValueError):
            resolve_provider("openai", {})
        with self.assertRaises(ValueError):
            Settings.from_env({"AIOS_PORT": "70000"})


if __name__ == "__main__":
    unittest.main()
