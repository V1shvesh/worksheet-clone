// @ts-check
import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

/**
 * Shared ESLint flat config, extended by each package/app.
 * Includes the ag-grid-* import ban up front (ADR-0001) even though the
 * dependency doesn't exist yet — the rule should already be in place before
 * `apps/web/src/features/grid/adapters/ag-grid` is created in M4b.
 */
export const baseConfig = tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "@typescript-eslint/no-explicit-any": "error",
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["ag-grid-*"],
              message:
                "ag-grid-* may only be imported inside features/grid/adapters/ag-grid/** (ADR-0001).",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["**/features/grid/adapters/ag-grid/**"],
    rules: {
      "no-restricted-imports": "off",
    },
  },
  {
    ignores: ["**/dist/**", "**/.turbo/**", "**/coverage/**"],
  },
);

export default baseConfig;
