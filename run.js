#!/usr/bin/env node

const path = require("path");
const fs = require("fs");
const child = require("child_process");

const __cwd = process.cwd();

const package = process.argv[2];

const package_path = package.split("/").filter(f => f && f.length);

const full_path = (partial_path) => path.join(__cwd, "libs", partial_path.join(path.sep));

const package_root = path.join(__cwd, "libs", package);

child.execSync(`npm install ${package}`, { cwd: __cwd});
try {
    child.execSync(`npm install @types/${package}`, { cwd: __cwd});
} catch (e) {}

const copy_types = (scan_dir, subdirs, extension, recursive) => {
    const files = fs.readdirSync(path.join(scan_dir, ...subdirs));
    try {
        fs.mkdirSync(path.join(package_root, ...subdirs));
    } catch (e) { }

    let copy = [];
    for (key in files) {
        if (files[key].indexOf(extension) !== -1) {
            fs.copyFileSync(path.join(scan_dir, ...subdirs, files[key]), path.join(package_root, ...subdirs, files[key]));
            copy.push(path.join(package_root, ...subdirs, files[key]));
        } else if (fs.fstatSync(fs.openSync(path.join(scan_dir, ...subdirs, files[key]))).isFile() == false && recursive) {
            copy.concat(copy_types(scan_dir, [...subdirs, files[key]], extension, true));
        }
    }
    return copy
}

(async () => {
    for (let i = 0; i < package_path.length; i++) {

        if (!fs.existsSync(full_path(package_path.slice(0, i + 1)))) {
            fs.mkdirSync(full_path(package_path.slice(0, i + 1)));
        }
    }

    try {
        fs.unlinkSync(path.join(__cwd, "__deps.json"));
    } catch (e) {

    }

    fs.writeFileSync(path.join(__cwd, "__deps.json"), "{}");

    const package_json = JSON.parse(fs.readFileSync(path.join(__cwd, "node_modules", package, "package.json")));

    let entry = path.join(__cwd, `/node_modules/${package}/${package_json.main || "index.js"}`);

    let has_gen_entry = false;
    if (fs.existsSync(entry) == false) {
        has_gen_entry = true;
        entry = path.join(__cwd, `/node_modules/${package}/index.js`);
        let includes = [];
        const files = fs.readdirSync(path.join(__cwd, `/node_modules/${package}`));
        for (key in files) {

            if (fs.fstatSync(fs.openSync(path.join(__cwd, `/node_modules/${package}/${files[key]}`))).isFile() == false) {
                const subfiles = fs.readdirSync(path.join(__cwd, `/node_modules/${package}/${files[key]}`));
                let possible_files = subfiles.filter(f => f.indexOf(".js") !== -1 && f.indexOf(".json") === -1).sort((a, b) => a.split("").filter(f => f == ".").length > b.split("").filter(f => f == ".").length ? 1 : -1);
                if (possible_files.length > 0) {
                    includes.push([files[key], possible_files[0]]);
                }
            }
        }
        
        let new_index = "module.exports = {\n";
        includes.forEach(([mod, file]) => {
            new_index += `  ${mod}: require("./${mod}/${file}"),\n`;
        });
        new_index += "};";

        fs.writeFileSync(path.join(__cwd, `/node_modules/${package}/index.js`), new_index);
    }

    if (fs.existsSync(path.join(__cwd, "node_modules", package, "README.md"))) {
        fs.copyFileSync(path.join(__cwd, "node_modules", package, "README.md"), path.join(full_path(package_path), "README.md"));
    } else if (fs.existsSync(path.join(__cwd, "node_modules", package, "readme.md"))) {
        fs.copyFileSync(path.join(__cwd, "node_modules", package, "readme.md"), path.join(full_path(package_path), "README.md"));
    } else {
        // no readme
    }

    // minified build
    await new Promise((res, rej) => {
        const prod = child.spawn(`./node_modules/.bin/webpack-cli`, [`--progress`, `--config`, `webpack.config.prod.5.js`, `--env`, `cwd=${Buffer.from(__cwd).toString('base64')}`, `type=prod`, `mod=${package}`], {
            cwd: __dirname,
            detached: true,
            stdio: "inherit"
          });

        prod.on('exit', res);
    });

    // non minified build
    await new Promise((res, rej) => {
        const prod = child.spawn(`./node_modules/.bin/webpack-cli`, [`--progress`, `--config`, `webpack.config.prod.5.js`, `--env`,`cwd=${Buffer.from(__cwd).toString('base64')}`, `type=dev`, `mod=${package}`], {
            cwd: __dirname,
            detached: true,
            stdio: "inherit"
          });

        prod.on('exit', res);
    });

    const version = child.execSync(`npm view ${package} version`).toString();

    const shasum = child.execSync(`shasum -b -a 512 libs/${package}/index.min.js | awk '{ print $1 }' | xxd -r -p | base64`);
    const shasumDev = child.execSync(`shasum -b -a 512 libs/${package}/index.js | awk '{ print $1 }' | xxd -r -p | base64`);

    try {
        fs.unlinkSync(path.join(__cwd, "libs", package, "lib.js"));
    } catch (e) {

    }

    const sizeProd = fs.readFileSync(path.join(__cwd, "libs", package, "index.min.js")).toString().length;
    const sizeDev = fs.readFileSync(path.join(__cwd, "libs", package, "index.js")).toString().length;

    // copy css files
    let css_files = copy_types(path.join(__cwd, "node_modules", package), [], ".css", false);

    fs.writeFileSync(path.join(__cwd, "libs", package, "lib.json"), `
    {
        "api": 1,
        "name": "${package}",
        "description": "${package_json.description}",
        "author": ${package_json.author == undefined ? '""' : JSON.stringify(package_json.author)},
        "version": "${version.slice(0, version.length - 1)}",
        "repo": ${JSON.stringify(package_json.repository)},
        "homepage": "${package_json.homepage}",
        "keywords": ${JSON.stringify(package_json.keywords || [])},
        "license": "${package_json.license}",
        "dependencies": ${JSON.stringify(JSON.parse(fs.readFileSync(path.join(__cwd, "__deps.json")).toString()), null, 4).replace(/    /img, "        ").replace("}", "    }")},
        "files": [
            {"file": "index.min.js", "sri": "sha512-${shasum.slice(0, shasum.length - 1)}", "sizeKB": ${sizeProd/1000}}
        ],
        "devFiles": [
            {"file": "index.js", "sri": "sha512-${shasumDev.slice(0, shasum.length - 1)}", "sizeKB": ${sizeDev/1000}}
        ]
    }
    `.trim());

    try {
        fs.unlinkSync(path.join(__cwd, "__deps.json"));
    } catch (e) {

    }

    if (has_gen_entry) {
        fs.unlinkSync(path.join(__cwd, `/node_modules/${package}/index.js`));
    }


    // Checks for TS files and copy them over
    const types_root = path.join(__cwd, "node_modules", "@types", package);

    // check for ts files
    if (fs.existsSync(types_root)) {
        copy_types(types_root, [], ".d.ts", true);
    } else { // try to find types in node_modules
        copy_types(path.join(__cwd, "node_modules", package), [], ".d.ts", true);
    }

    // copy eot, svg, ttf, and woff files over
    copy_types(path.join(__cwd, "node_modules", package), [], ".eot", true);
    copy_types(path.join(__cwd, "node_modules", package), [], ".woff", true);
    copy_types(path.join(__cwd, "node_modules", package), [], ".svg", true);
    copy_types(path.join(__cwd, "node_modules", package), [], ".ttf", true);

    // sometimes node_modules interior directory gets coppied over, remove it if it's there
    try {
       fs.rmSync(path.join(__cwd, "libs", package, "node_modules"), {recursive: true });
    } catch (e) {

    }

    child.execSync(`npm uninstall ${package}`, { cwd: __cwd});
    try {
        child.execSync(`npm uninstall @types/${package}`, { cwd: __cwd});
    } catch (e) {}


})()