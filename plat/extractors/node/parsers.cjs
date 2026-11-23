const path = require("node:path");
const { createRequire } = require("node:module");

const parserRequire = createRequire(path.join(process.argv[2], "package.json"));

exports.ts = parserRequire("typescript");
exports.vue = parserRequire("@vue/compiler-sfc");
