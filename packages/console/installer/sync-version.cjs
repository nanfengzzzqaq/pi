// 版本同步：把 console 的版本写入 electron 工程 package.json（UTF-8 安全）
const fs = require("fs");
const consolePkg = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const electronPkg = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
electronPkg.version = consolePkg.version;
fs.writeFileSync(process.argv[3], JSON.stringify(electronPkg, null, "\t") + "\n");
console.log("版本 -> " + consolePkg.version);
