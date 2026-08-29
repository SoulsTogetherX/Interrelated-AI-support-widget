//#region Why this file
// The architecture as ENFORCED LAW (2026-08 org overhaul). Every rule here
// existed before, as prose in the reference docs; an agent (or a tired
// human) can ignore documentation, not a CI failure. dependency-cruiser was
// chosen over the eslint boundary plugins because it is indifferent to this
// repo's package-less folders (shared/, providers/ have no package.json by
// design), resolves the tsconfig path aliases, and treats `import type` as
// its own dependency class - which several rules below hang on.
//
// Run via `npm run depcruise` (two passes: web/ resolves aliases through
// its own tsconfig; everything else through realtime's).
//#endregion

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "shared-is-dependency-free",
      comment:
        "shared/ has no package.json, so it CANNOT declare dependencies - " +
        "therefore it must not need any (ref §2.4). Type-only imports are " +
        "fine (erased at compile time; kysely types are the precedent), " +
        "and node builtins appear only in files documented to use them.",
      severity: "error",
      from: { path: "^shared/" },
      to: {
        pathNot: "^shared/",
        dependencyTypesNot: ["core", "type-only"],
      },
    },
    {
      name: "providers-import-only-shared",
      comment:
        "providers/ is the adapter layer: shared/ contracts below it, " +
        "application packages above it. A providers/ file importing from " +
        "realtime/ or web/ inverts the dependency direction (ref §2.4.5).",
      severity: "error",
      from: { path: "^providers/" },
      to: { path: "^(realtime|web|widget|eval|loadtest|scripts)/" },
    },
    {
      name: "widget-runtime-imports-nothing",
      comment:
        "The widget is standalone by contract: zero runtime dependencies, " +
        "15KB budget. It may take TYPES from shared/ (erased), plus the " +
        "documented value exception - handoff/protocol.ts constants, which " +
        "esbuild inlines (ref §8).",
      severity: "error",
      from: { path: "^widget/src/" },
      to: {
        path: "^shared/",
        pathNot: "^shared/handoff/protocol\\.ts$",
        dependencyTypesNot: ["type-only"],
      },
    },
    {
      name: "widget-never-touches-app-code",
      severity: "error",
      from: { path: "^widget/src/" },
      to: { path: "^(realtime|web|providers|eval|loadtest)/" },
    },
    {
      name: "web-is-control-plane-only",
      comment:
        "web/ never imports providers/ (adapters open sockets; a Server " +
        "Component must not be able to reach one to read a constant - ref " +
        "§2.4.8) and never imports realtime/ (the services talk over the " +
        "internal HTTP API, not through code).",
      severity: "error",
      from: { path: "^web/" },
      to: { path: "^(providers|realtime)/" },
    },
    {
      name: "realtime-never-imports-web",
      severity: "error",
      from: { path: "^realtime/" },
      to: { path: "^web/" },
    },
    {
      name: "production-code-never-imports-tests",
      severity: "error",
      from: { pathNot: "__tests__|\\.test\\.(ts|tsx|mjs)$" },
      to: { path: "__tests__" },
    },
    {
      name: "no-circular",
      comment: "Cycles are how 'Cannot access X before initialization' is born.",
      severity: "error",
      from: {},
      to: { circular: true, viaOnly: { dependencyTypesNot: ["type-only"] } }, // type-edge cycles are erased at compile time (widget api<->handoff); only VALUE cycles can fault at runtime
    },
    {
      name: "no-orphans",
      comment:
        "A module nothing imports and no script runs is dead weight or a " +
        "wiring mistake. Warn-level: entrypoints and config files are " +
        "excluded, but a knip run (npm run knip) is the authoritative " +
        "dead-code check.",
      severity: "warn",
      from: {
        orphan: true,
        pathNot: [
          "^scripts/", // repo-root probes: standalone entrypoints by design, run by node directly
          "\\.d\\.ts$",
          "(^|/)[^/]+\\.config\\.(ts|mjs|cjs)$",
          "\\.dependency-cruiser\\.cjs$",
        ].join("|"),
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: {
      path: [
        "\\.probe/",
        "\\.playground/",
        "eval/corpus/",
        "eval/results/",
        "local_cache/",
        "/dist/",
        "\\.next/",
      ].join("|"),
    },
    // REQUIRED for the type-only dependency class to exist at all.
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.depcruise.json" },
    cache: { strategy: "metadata" },
    reporterOptions: { text: { highlightFocused: true } },
  },
}
