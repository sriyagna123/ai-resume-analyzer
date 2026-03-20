const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function npm(cwd, args) {
  // In Windows environments npm.cmd exists; in Linux/macOS it is just `npm`.
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  const res = spawnSync(npmCmd, args, { cwd, stdio: "inherit" });
  if (res.status !== 0) {
    throw new Error(`Command failed: ${npmCmd} ${args.join(" ")}`);
  }
}

const frontendDir = path.join(__dirname, "..", "frontend");
const distDir = path.join(frontendDir, "dist");
const indexHtml = path.join(distDir, "index.html");

// If a platform deploy only installs the backend, the React build may be missing.
// Build it automatically so the same URL can serve both UI and API.
if (!fs.existsSync(indexHtml)) {
  console.log("frontend/dist missing -> building frontend...");
  // Use package-lock.json for reproducible installs.
  npm(frontendDir, ["ci"]);
  npm(frontendDir, ["run", "build"]);
} else {
  console.log("frontend/dist found -> skipping frontend build");
}

require("./server");

