/**
 * Every libraries.json entry must be a checkin-app dependency (a missing workspace
 * dep resolves locally but fails the Docker/CI build), transpiled by Next, and
 * wired at boot from src/lib/<camelCase name>/configure.ts by instrumentation.ts.
 */
import fs from "node:fs";
import path from "node:path";
import libraries from "../../libraries.json";
import pkgJson from "../../package.json";
import nextConfig from "../../next.config";

const camel = (name: string) => name.replace(/_(\w)/g, (_, c: string) => c.toUpperCase());
const instrumentation = fs.readFileSync(path.join(__dirname, "../instrumentation.ts"), "utf8");

describe.each(libraries.map((lib) => [lib.name, lib.package]))("libraries.json %s", (name, pkg) => {
  it("is a checkin-app dependency", () => {
    expect(Object.keys(pkgJson.dependencies)).toContain(pkg);
  });

  it("is transpiled by Next", () => {
    expect(nextConfig.transpilePackages).toContain(pkg);
  });

  it("is wired at boot from its configure module", () => {
    const dir = camel(name);
    expect(fs.existsSync(path.join(__dirname, `../lib/${dir}/configure.ts`))).toBe(true);
    expect(instrumentation).toContain(`import("@/lib/${dir}/configure")`);
  });
});
