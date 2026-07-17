import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function userHome() {
  return process.env.HOME || process.env.USERPROFILE || "";
}

export function defaultCodexHome() {
  return process.env.CODEX_HOME || normalDefaultCodexHome();
}

export function normalDefaultCodexHome() {
  return path.join(userHome(), ".codex");
}

export function managedGroupCodexHome(groupName) {
  if (groupName === "default") {
    return defaultCodexHome();
  }
  return path.join(userHome(), "codex-auth-advanced", "groups", groupName);
}

export function projectsConfigPath() {
  return path.join(userHome(), "codex-auth-advanced", "projects.json");
}

export function managerPidPath() {
  return path.join(userHome(), "codex-auth-advanced", "manager.pid");
}

export function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function writeJsonFile(filePath, value) {
  writeTextFilePrivate(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function writeJsonFileInPlace(filePath, value) {
  writeTextFilePrivateInPlace(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function copyFilePrivate(sourcePath, targetPath) {
  const tempPath = privateTempPath(targetPath);
  try {
    fs.copyFileSync(sourcePath, tempPath);
    fs.chmodSync(tempPath, 0o600);
    fs.renameSync(tempPath, targetPath);
  } finally {
    if (fs.existsSync(tempPath)) {
      fs.rmSync(tempPath, { force: true });
    }
  }
}

function privateTempPath(filePath) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const suffix = `${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
  return path.join(dir, `.${base}.${suffix}.tmp`);
}

export function writeTextFilePrivate(filePath, value, mode = 0o600) {
  const tempPath = privateTempPath(filePath);
  try {
    fs.writeFileSync(tempPath, value, { encoding: "utf8", mode });
    fs.chmodSync(tempPath, mode);
    fs.renameSync(tempPath, filePath);
  } finally {
    if (fs.existsSync(tempPath)) {
      fs.rmSync(tempPath, { force: true });
    }
  }
}

export function writeTextFilePrivateInPlace(filePath, value, mode = 0o600) {
  fs.writeFileSync(filePath, value, { encoding: "utf8", mode });
  fs.chmodSync(filePath, mode);
}

function timestampForBackup() {
  const now = new Date();
  const pad2 = (value) => String(value).padStart(2, "0");
  return [
    now.getFullYear(),
    pad2(now.getMonth() + 1),
    pad2(now.getDate()),
    "-",
    pad2(now.getHours()),
    pad2(now.getMinutes()),
    pad2(now.getSeconds())
  ].join("");
}

export function backupIfExists(filePath) {
  if (!fs.existsSync(filePath)) return;
  const backupPath = `${filePath}.bak.${timestampForBackup()}`;
  fs.copyFileSync(filePath, backupPath);
  fs.chmodSync(backupPath, 0o600);
}

export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
}

function accountFileKey(accountKey) {
  if (/^[A-Za-z0-9_.-]+$/.test(accountKey) && accountKey !== "." && accountKey !== "..") {
    return accountKey;
  }
  return Buffer.from(accountKey, "utf8").toString("base64url");
}

export function accountAuthPath(codexHome, accountKey) {
  return path.join(codexHome, "accounts", `${accountFileKey(accountKey)}.auth.json`);
}

export function accountConfigPath(codexHome, accountKey) {
  return path.join(codexHome, "accounts", `${accountFileKey(accountKey)}.config.toml`);
}

export function rootConfigPath(codexHome) {
  return path.join(codexHome, "config.toml");
}

export function accountKeyFromApiKey(apiKey) {
  return `apikey-${crypto.createHash("sha256").update(apiKey).digest("hex").slice(0, 16)}`;
}

export function registryPath(codexHome) {
  return path.join(codexHome, "accounts", "registry.json");
}

export function providerDashboardCredentialsDir(codexHome) {
  return path.join(codexHome, "accounts", "provider-dashboard");
}

export function readTextFile(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

export function realPathIfPossible(filePath) {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

export function pathContains(parentPath, childPath) {
  const relative = path.relative(parentPath, childPath);
  return relative === "" || (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative));
}
