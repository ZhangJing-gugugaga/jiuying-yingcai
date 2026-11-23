"""Create a credential-free V3.3 ZIP; verify an independent clean extraction."""
from datetime import datetime
from hashlib import sha256
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile
import json
import os
import shutil
import subprocess

root = Path(__file__).resolve().parents[1]
delivery = Path(os.environ.get("JIUYING_DELIVERY_DIR", root.parent / "V3.3全量问题整改交付")).resolve()
delivery.mkdir(parents=True, exist_ok=True)
stamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
archive = delivery / "九盈英才_V3.3_全量问题整改_完整源码.zip"
candidate = delivery / f"候选源码_{stamp}.zip"
verify_dir = delivery / f"源码复验_{stamp}"
logs = delivery / f"验包日志_{stamp}"
logs.mkdir()
report_names = (
    "当前问题关闭矩阵.csv", "V3.3最终整改报告.md", "V3.3当前发布状态.md", "文档一致性整改报告.md",
    "19页C端逐页体验检查.md", "前端已修复问题清单.md", "前端待产品确认功能清单.md",
    "核心业务跨模块复核报告.md", "后端缺陷整改矩阵.csv", "安全与生产放行检查.md",
    "微信模拟器实际验证报告.md", "微信IDE与模拟器阻断诊断.md", "微信19页模拟器逐页验证表.md",
    "微信模拟器人工解锁步骤.md", "最终测试报告.md", "最终验包摘要.json",
)
missing = [name for name in report_names if not (root / "docs" / name).is_file()]
if missing:
    raise SystemExit(f"Missing delivery documents: {', '.join(missing)}")
if archive.exists():
    raise SystemExit(f"Existing release protected: {archive}")

directories = ("admin-web", "assets", "database", "docs", "miniprogram", "scripts", "server", "shared", "tests")
root_files = (".env.example", ".env.production.example", ".gitignore", ".npmrc", "package.json",
              "package-lock.json", "README.md", "start.ps1")
execution_names = ("PROGRESS", "DECISIONS", "EVIDENCE", "BLOCKERS")
excluded_parts = {"node_modules", "dist", ".git", "__pycache__", "var", "test-databases"}
excluded_suffixes = {".db", ".db-wal", ".db-shm", ".sqlite", ".sqlite3", ".log", ".pem", ".key", ".p12", ".pfx", ".pyc"}
files = [root / name for name in root_files] + [root / "execution" / f"V33_CLOSEOUT_{name}.md" for name in execution_names]
for directory in directories:
    for item in (root / directory).rglob("*"):
        relative = item.relative_to(root)
        if (item.is_file() and not item.is_symlink() and not excluded_parts.intersection(relative.parts)
            and item.name not in {".env", "project.private.config.json"}
            and not item.name.startswith(".env.") and item.suffix.lower() not in excluded_suffixes):
            files.append(item)
manifest = []
with ZipFile(candidate, "w", ZIP_DEFLATED) as out:
    for item in sorted(files):
        name = "jiuying-yingcai/" + item.relative_to(root).as_posix()
        payload = item.read_bytes()
        out.writestr(name, payload)
        manifest.append({"path": name, "bytes": len(payload), "sha256": sha256(payload).hexdigest()})

verify_dir.mkdir()
with ZipFile(candidate) as source:
    if source.testzip() is not None or len(source.namelist()) != len({x.casefold() for x in source.namelist()}):
        raise SystemExit("ZIP CRC or duplicate-member verification failed")
    for item in source.infolist():
        if not (verify_dir / item.filename).resolve().is_relative_to(verify_dir.resolve()):
            raise SystemExit("Invalid member path")
    source.extractall(verify_dir)
for entry in manifest:
    payload = (verify_dir / entry["path"]).read_bytes()
    if len(payload) != entry["bytes"] or sha256(payload).hexdigest() != entry["sha256"]:
        raise SystemExit(f"Invalid extracted payload: {entry['path']}")

cwd = verify_dir / "jiuying-yingcai"
# Carry only OS and package-cache settings. Never inherit app, credential or production DB variables.
os_env = {"path", "systemroot", "windir", "comspec", "pathext", "home", "userprofile", "localappdata",
          "appdata", "programfiles", "programfiles(x86)", "programdata", "temp", "tmp", "tmpdir",
          "systemdrive", "public", "username", "user", "npm_config_cache", "lang", "lc_all"}
env = {name: value for name, value in os.environ.items() if name.lower() in os_env}
env.update(NODE_ENV="test", ADAPTER_MODE="mock", DB_PATH=str(cwd / "var/migration-check.db"),
           V33_BROWSER_EVIDENCE=str(logs / "browser-content-support"),
           FINANCE_BROWSER_OUTPUT=str(logs / "browser-finance"))
npm = shutil.which("npm.cmd" if os.name == "nt" else "npm")
if not npm:
    raise SystemExit("npm is required")

tool_dir = Path(os.environ.get("WECHAT_DEVTOOLS_PATH", str(root / "execution/wechat-tools/devtools")))
compiler_dir = tool_dir / "resources/app.asar.unpacked/node_modules/wcc-exec"
if not all((compiler_dir / name).is_file() for name in ("wcc.exe", "wcsc.exe")):
    raise SystemExit(f"Both official compiler binaries are required. Check WECHAT_DEVTOOLS_PATH: {tool_dir}")
commands = [
    ("locked_install", [npm, "ci", "--registry=https://registry.npmjs.org"]),
    ("syntax", ["node", "scripts/check-syntax.cjs"]),
    ("migrate_fresh", ["node", "database/migrate.cjs"]),
    ("migrate_repeat", ["node", "database/migrate.cjs"]),
    ("node_all", ["node", "--test", *sorted(p.relative_to(cwd).as_posix() for p in (cwd/"tests").glob("*.test.cjs"))]),
    ("extracted_api_smoke", ["node", "scripts/verify-package.cjs"]),
]
commands += [(name, ["node", "tests/" + name]) for name in (
    "browser.cjs", "browser-round2.cjs", "browser-remediation.cjs", "browser-payments.cjs", "browser-v32.cjs",
    "browser-finance-ledger.cjs", "browser-v33-monthly.cjs", "browser-v33-content-support.cjs",
)]
commands += [
    ("wechat_source_static", ["node", "scripts/wechat-validate.cjs"]),
    ("bounded_load_smoke", ["node", "scripts/load-smoke.cjs"]),
    ("bounded_v32_load", ["node", "scripts/v32-load.cjs"]),
    ("wechat_prod_sample", ["node", "scripts/wechat-build.cjs", "--environment", "production", "--target", "device",
                            "--api-base", "https://example.invalid", "--app-id", "wx0000000000000000",
                            "--out", str(cwd / "execution/package-production-build")]),
    ("wechat_official_wcc_wcsc", ["node", "scripts/wechat-compile.cjs", "--tool-dir", str(tool_dir),
                                 "--out", str(cwd / "execution/package-native-compile")]),
    ("sqlite_backup", ["node", "scripts/backup.cjs", "create", str(cwd / "var/package-backup.db")]),
    ("sqlite_backup_verify", ["node", "scripts/backup.cjs", "verify", str(cwd / "var/package-backup.db")]),
    ("sqlite_restore", ["node", "scripts/backup.cjs", "restore", str(cwd / "var/package-backup.db"), str(cwd / "var/package-restored.db")]),
]
results = []
for index, (stage, command) in enumerate(commands, 1):
    log = logs / f"{index:02d}-{stage}.txt"
    try:
        run = subprocess.run(command, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                             timeout=300, encoding="utf-8", errors="replace")
        status, output = run.returncode, run.stdout
    except subprocess.TimeoutExpired as error:
        status, output = 124, (error.stdout or b"").decode("utf-8", "replace") + "\nTimed out after 300 s.\n"
    log.write_text(output, encoding="utf-8")
    result = {"stage": stage, "command": command, "exitCode": status, "log": log.relative_to(delivery).as_posix()}
    results.append(result)
    print(f"{index:02d} exit {status}: {stage}", flush=True)
    (logs / "command-results.json").write_text(json.dumps(results, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
    if status:
        raise SystemExit(f"Candidate not released. Failed verification: {log}")

for name in report_names:
    shutil.copy2(cwd / "docs" / name, delivery / name)
shutil.copy2(cwd/"execution/package-native-compile/compiler-result.json", logs/"官方编译记录.json")
shutil.copy2(cwd/"execution/package-production-build/build-manifest.json", logs/"生产构建剥离清单.json")
candidate.rename(archive)
archive_hash = sha256(archive.read_bytes()).hexdigest()
record = {"status": "passed", "archive": archive.name, "sha256": archive_hash,
          "fileCount": len(manifest), "archiveBytes": archive.stat().st_size,
          "freshExtraction": verify_dir.name, "commands": results, "officialCompilerRechecked": True,
          "baselineSha256": "7f173905e4cdd39151a75b2409f922e4d1fcf14735cb1650065d6d7528c49b47",
          "wechatSimulatorInteraction": "not_verified_by_package_runner", "platformPayments": "isolated_only", "files": manifest}
(delivery/"重新解压验包记录.json").write_text(json.dumps(record, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
(delivery/"SHA256文件清单.txt").write_text(
    f"{archive_hash}  {archive.name}\n"+"\n".join(f"{e['sha256']}  {e['path']}" for e in manifest)+"\n", encoding="utf-8")
print(json.dumps({key:value for key,value in record.items() if key not in ("files", "commands")}, ensure_ascii=True), flush=True)
