// Writes ui/vendor/LICENSES.txt with the licence of every package bundled into codemirror.js.
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..", "node_modules");
const pkgs = new Set();
const walk = (name) => {
  if (pkgs.has(name)) return;
  const dir = path.join(root, name);
  if (!fs.existsSync(path.join(dir, "package.json"))) return;
  pkgs.add(name);
  const pj = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  Object.keys(pj.dependencies || {}).forEach(walk);
};
["codemirror", "@codemirror/lang-sql", "@codemirror/lint", "@lezer/highlight"].forEach(walk);
const out = ["Third-party code bundled in codemirror.js", "=".repeat(42), ""];
for (const name of [...pkgs].sort()) {
  const dir = path.join(root, name);
  const pj = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  const lic = ["LICENSE", "LICENSE.md", "LICENSE.txt"].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
  out.push(`${name}@${pj.version} (${pj.license})`, "-".repeat(40), lic ? fs.readFileSync(lic, "utf8").trim() : "(no licence file)", "");
}
fs.writeFileSync(path.join(__dirname, "..", "ui", "vendor", "LICENSES.txt"), out.join("\n"));
console.log(`wrote licences for ${pkgs.size} packages`);
