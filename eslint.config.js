import js from "@eslint/js";
import globals from "globals";
import { defineConfig } from "eslint/config";
import pluginRegexp from "eslint-plugin-regexp";
import html from "eslint-plugin-html";

export default defineConfig([
  {
    files: ["**/*.{js,mjs,cjs}"],
    plugins: { 
      js,
      regexp: pluginRegexp
    },
    extends: ["js/recommended"],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      "no-unused-vars": [
        "error",
        {
          varsIgnorePattern:
            "^(cancelTranscription|cancelTranslation|pid|error|_error|writeCacheFile|_err)$",
          argsIgnorePattern: "^_",
        },
      ],
      "regexp/no-dupe-disjunctions": "error",
      "regexp/optimal-quantifier-concatenation": "warn",
      // Disable regex control character warnings for file sanitization
      "no-control-regex": "off",
      // Allow unnecessary escapes in regex (for path sanitization)
      "no-useless-escape": "off"
    },
  },
  {
    files: ["**/*.html"],
    plugins: { html }
  }
]);
