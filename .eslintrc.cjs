/** @type {import("eslint").Linter.Config} */
module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
  plugins: ["@typescript-eslint", "import"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "plugin:import/recommended",
    "plugin:import/typescript",
  ],
  settings: {
    "import/resolver": {
      typescript: {
        project: ["packages/*/tsconfig.json"],
      },
      node: true,
    },
  },
  rules: {
    "@typescript-eslint/no-unused-vars": [
      "warn",
      { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
    ],
    "@typescript-eslint/no-explicit-any": "warn",

    // The MCP SDK uses wildcard package.json exports ("./*": ...) that
    // resolve fine for tsc but eslint-plugin-import's TS resolver doesn't
    // follow. Skip the unresolved check for those deep imports specifically.
    "import/no-unresolved": [
      "error",
      { ignore: ["^@modelcontextprotocol/sdk/"] },
    ],

    // Hexagonal dep rules for packages/core/
    // domain/ → nothing
    // ports/ → domain only
    // services/ → domain + ports (NEVER adapters)
    // adapters/ → ports + domain
    "import/no-restricted-paths": [
      "error",
      {
        zones: [
          {
            target: "./packages/core/src/domain",
            from: "./packages/core/src",
            except: ["./packages/core/src/domain"],
            message: "domain/ must not import from other core modules",
          },
          {
            target: "./packages/core/src/ports",
            from: "./packages/core/src",
            except: [
              "./packages/core/src/domain",
              "./packages/core/src/ports",
            ],
            message: "ports/ may only import from domain/",
          },
          {
            target: "./packages/core/src/services",
            from: "./packages/core/src/adapters",
            message:
              "services/ must NOT import from adapters/ — depend on ports instead",
          },
        ],
      },
    ],
  },
  ignorePatterns: [
    "dist/**",
    "node_modules/**",
    "*.cjs",
    "*.js",
    "*.config.ts",
  ],
};
