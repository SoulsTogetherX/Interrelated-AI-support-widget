//#region Why this file
// The lint layer of the org-overhaul enforcement stack (2026-08): one ROOT
// flat config serving every package in this deliberately non-workspace
// repo. typescript-eslint's projectService discovers each package's own
// tsconfig per file, so realtime/, web/, widget/, shared/, providers/,
// eval/ and loadtest/ all get TYPE-AWARE rules without per-package configs.
//
// Rule philosophy (research-backed, see the overhaul plan):
//   - Correctness rules are ERRORS (floating promises, exhaustiveness,
//     complexity) - complexity IS defect-predictive.
//   - SIZE rules are WARN budgets with skipComments: this codebase's high
//     WHY-comment density is a feature, and the literature does not support
//     hard length caps (Google's guide is silent; Airbnb ships them off).
//     `--max-warnings 0` in CI still makes a breach fail loudly - the
//     escape hatch is a REVIEWED eslint-disable with a reason, not silence.
//   - Tests are exempt from size/duplication discipline on purpose (DAMP
//     over DRY - SWE-at-Google ch.12); focused tests are the error there.
//   - Boundary rules here are the in-editor mirror; dependency-cruiser is
//     the authoritative graph check (.dependency-cruiser.cjs).
//#endregion

import js from "@eslint/js"
import globals from "globals"
import tseslint from "typescript-eslint"
import sonarjs from "eslint-plugin-sonarjs"
import vitest from "@vitest/eslint-plugin"

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "web/.next/**",
      "local_cache/**",
      ".probe/**",
      ".playground/**",
      "eval/corpus/**",
      "eval/results/**",
      "widget/fixtures/**",
    ],
  },

  //#region TypeScript - type-aware everywhere
  {
    files: ["**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: {
          // Config files that sit in no package's tsconfig (globs here may
          // not use **, per typescript-eslint's parser docs).
          allowDefaultProject: [
            "*.mjs",
            "vitest.config.ts",
            "realtime/vitest.config.ts",
            "web/vitest.config.ts",
            "web/next.config.ts",
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { sonarjs },
    rules: {
      // ── Size budgets (warn): triggers to look, not verdicts to split.
      "max-lines": ["warn", { max: 1000, skipBlankLines: true, skipComments: true }],
      "max-lines-per-function": ["warn", { max: 200, skipBlankLines: true, skipComments: true }],
      // ── Complexity (error): the defect-predictive half.
      complexity: ["error", 15],
      "sonarjs/cognitive-complexity": ["error", 15],
      "max-params": ["error", 4],
      "max-depth": ["error", 4],
      // ── Async correctness: the rules Biome could only approximate, and
      //    the reason this stack won the toolchain decision.
      "@typescript-eslint/no-floating-promises": "error",
      // OFF, deliberately: every one of its 30 findings here was an
      // implementation of an async INTERFACE (mock providers, scripted
      // fixtures, Kysely's MigrationProvider) where the signature demands a
      // Promise and the body needs no await. "Fixing" those means swapping
      // documented `async` for `return Promise.resolve()` noise.
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/switch-exhaustiveness-check": [
        "error",
        { considerDefaultExhaustiveForUnions: false },
      ],
      // (Quote/semicolon style is Prettier's law, not ESLint's - duplicating
      // the formatter in lint is the drift the eslint-config-prettier
      // ecosystem exists to prevent.)
      // Codebase idiom: non-null assertions appear where an invariant was
      // just established (checkCredentialInput etc.) with the WHY beside
      // them. Banning them wholesale would trade documented assertions for
      // undocumented `as` casts.
      "@typescript-eslint/no-non-null-assertion": "off",
      // The pipeline logs errors as `${error}` in several places on purpose
      // (provider errors are pre-sanitized); recommendedTypeChecked's
      // template restriction fights that idiom more than it protects it.
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true, allowBoolean: true, allowNever: true },
      ],
    },
  },
  //#endregion

  //#region Build-config files: their own tools type-check them
  // next.config.ts / vitest configs sit outside every package tsconfig; the
  // default-project parse resolves their imports as `any`, so type-aware
  // rules there report tooling noise, not code. `next build` and vitest
  // parse them for real.
  {
    files: ["**/*.config.ts"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  //#endregion

  //#region Boundary mirrors (authoritative check: dependency-cruiser)
  {
    files: ["widget/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@providers/*"],
              message: "widget/ is standalone - 15KB budget, zero runtime deps (ref §8).",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["web/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@providers/*"],
              message:
                "web/ is the control plane; providers/ opens sockets. Read pricing/plans via @shared (ref §2.4.8).",
            },
          ],
        },
      ],
    },
  },
  //#endregion

  //#region Measurement harnesses and seeds: glue by doctrine (ref §3.11)
  // The eval/compare/loadtest/seed CLIs are deliberately big linear main()
  // functions - "glue over the same inserts the tests make, no logic of its
  // own to drift". Complexity metrics hate a 300-line linear narrative and
  // are wrong to: splitting a measurement script scatters the procedure it
  // exists to make reviewable. Same stance as the zero-dependency probes.
  {
    files: ["realtime/scripts/**/*.ts", "web/scripts/**/*.ts"],
    rules: {
      "max-lines": "off",
      "max-lines-per-function": "off",
      "sonarjs/cognitive-complexity": "off",
      complexity: "off",
      "max-params": "off",
      "max-depth": "off",
    },
  },
  //#endregion

  //#region Tests: DAMP over DRY - size rules off, focus is the sin
  {
    files: ["**/__tests__/**", "**/*.test.{ts,tsx}", "**/*.test.mjs"],
    plugins: { vitest },
    rules: {
      "max-lines": "off",
      "max-lines-per-function": "off",
      "sonarjs/cognitive-complexity": "off",
      complexity: "off",
      "vitest/no-focused-tests": "error",
      "vitest/no-disabled-tests": "warn",
      // Fixture builders legitimately take many positional params.
      "max-params": "off",
      // Test fixtures legitimately do unsafe-looking things on purpose.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/unbound-method": "off",
    },
  },
  //#endregion

  //#region Zero-dependency .mjs probes and tooling scripts
  {
    files: ["**/*.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      // The probes are DELIBERATELY single-file (runnable with no npm
      // install, pointable at any deployment) - size budgets do not apply.
      "max-lines": "off",
      "max-lines-per-function": "off",
      "sonarjs/cognitive-complexity": "off",
      complexity: "off",
      "@typescript-eslint/no-floating-promises": "off",
    },
  },
  //#endregion
)
