module.exports = {
  env: { es2022: true, node: true },
  extends: ["eslint:recommended","plugin:import/recommended","prettier"],
  parserOptions: { ecmaVersion: "latest", sourceType: "module" },
  rules: { "no-unused-vars":["warn",{"argsIgnorePattern":"^_","varsIgnorePattern":"^_"}],
    "import/order":["warn",{ "newlines-between":"always", "alphabetize":{"order":"asc"} }]
  }
};