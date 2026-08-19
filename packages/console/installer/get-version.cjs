// 输出 electron 工程 package.json 的版本号（供 PowerShell 捕获）
const fs = require("fs");
console.log(JSON.parse(fs.readFileSync(process.argv[2], "utf8")).version);
