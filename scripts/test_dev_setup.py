import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from scripts import dev_setup


class DevSetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / "config").mkdir()
        self.catalog = {
            "defaults": {"provider": "test", "tl": "text"},
            "providers": {
                "test": {
                    "keyEnvVar": "TEST_API_KEY",
                    "defaultTLModel": "text",
                    "defaultOCRModel": "vision",
                    "defaultQALLMModel": "text",
                    "defaultQAVLMModel": "vision",
                    "models": {
                        "tl": [{"id": "text"}],
                        "ocr": [{"id": "vision"}],
                        "qaLLM": [{"id": "text"}],
                        "qaVLM": [{"id": "vision"}],
                    },
                }
            },
        }
        (self.root / "config/providers.json").write_text(json.dumps(self.catalog))
        self.import_path = self.root / "keys.json"
        self.import_path.write_text(json.dumps({"TEST_API_KEY": "fixture-private-key"}))

    def tearDown(self):
        self.temp.cleanup()

    def test_catalog_defaults_seed_qa_without_static_model_env(self):
        report = dev_setup.initialize(self.root, True, self.import_path, None)
        self.assertEqual(report["models"]["QA_VLM_MODEL"], "vision")
        self.assertEqual(report["models"]["QA_MODE"], "auto")
        runtime = self.root / "secrets/runtime"
        self.assertNotIn("fixture-private-key", (runtime / "models.env").read_text())
        self.assertEqual(runtime.stat().st_mode & 0o777, 0o700)
        self.assertEqual((runtime / "api_keys.json").stat().st_mode & 0o777, 0o444)
        original = (self.root / "secrets/db_password.txt").read_bytes()
        self.catalog["providers"]["test"]["models"]["tl"].append({"id": "new-text"})
        self.catalog["defaults"]["tl"] = "new-text"
        (self.root / "config/providers.json").write_text(json.dumps(self.catalog))
        updated = dev_setup.initialize(self.root, True, None, None)
        self.assertEqual(updated["models"]["TL_LLM_MODEL"], "new-text")
        self.assertEqual((self.root / "secrets/db_password.txt").read_bytes(), original)

    def test_explicit_overrides_and_fallbacks_remain_explicit(self):
        overrides = {"QA_MODE": "llm", "TL_LLM_MODEL_LIST": "text,other"}
        result = dev_setup.resolve_models(
            self.catalog, {"TEST_API_KEY": "key"}, overrides
        )
        self.assertEqual(result["TL_LLM_MODEL"], "text")
        self.assertEqual(result["TL_LLM_MODEL_LIST"], "text,other")
        self.assertEqual(result["QA_MODE"], "llm")
        with self.assertRaises(ValueError):
            dev_setup.resolve_models(self.catalog, {}, {"TL_MODEL_PROVIDER": "test"})

    def test_no_keys_reports_cloud_translation_unavailable(self):
        report = dev_setup.initialize(self.root, True, None, None)
        self.assertFalse(report["cloud_translation_configured"])
        self.assertEqual(report["models"]["QA_MODE"], "none")

    def test_yolo_copy_is_verified_and_idempotent(self):
        source = self.root / "source.onnx"
        source.write_bytes(b"test-artifact")
        config = self.root / "worker/src/worker/config.py"
        config.parent.mkdir(parents=True)
        config.write_text(
            f'YOLO_PINNED_CHECKSUM = "{hashlib.sha256(source.read_bytes()).hexdigest()}"\n'
        )
        self.assertTrue(dev_setup.install_yolo(self.root, source))
        self.assertTrue(dev_setup.install_yolo(self.root, None))
        source.write_bytes(b"wrong-artifact")
        with self.assertRaisesRegex(ValueError, "checksum mismatch"):
            dev_setup.install_yolo(self.root, source)
        self.assertEqual(
            (self.root / "data/bootstrap/yolo11n_bubble.onnx").read_bytes(),
            b"test-artifact",
        )

    def test_exec_passes_secret_in_child_environment_without_echoing(self):
        dev_setup.initialize(self.root, True, self.import_path, None)
        result = subprocess.run(
            [
                sys.executable,
                str(dev_setup.REPO / "scripts/dev_setup.py"),
                "--root",
                str(self.root),
                "exec",
                "--",
                sys.executable,
                "-c",
                "import os; assert os.environ['TEST_API_KEY']=='fixture-private-key'",
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("fixture-private-key", result.stdout + result.stderr)

    @unittest.skipUnless(shutil.which("docker"), "Docker Compose CLI unavailable")
    def test_compose_resolves_isolated_services_with_generated_defaults(self):
        dev_setup.initialize(self.root, True, self.import_path, None)
        shutil.copyfile(
            dev_setup.REPO / "docker-compose.dev.yml",
            self.root / "docker-compose.dev.yml",
        )
        result = subprocess.run(
            [
                "docker",
                "compose",
                "--env-file",
                str(self.root / ".env"),
                "-f",
                str(self.root / "docker-compose.dev.yml"),
                "config",
                "--format",
                "json",
            ],
            env={**os.environ, "COMPOSE_DISABLE_ENV_FILE": "true"},
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        config = json.loads(result.stdout)
        self.assertEqual(
            set(config["services"]), {"db", "redis", "minio", "backend", "worker"}
        )
        self.assertEqual(
            config["services"]["worker"]["environment"]["QA_VLM_MODEL"], "vision"
        )
        self.assertTrue(
            all(not value.get("external") for value in config["networks"].values())
        )


if __name__ == "__main__":
    unittest.main()
