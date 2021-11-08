#!/usr/bin/env node

const path = require("path");
const fs = require("fs");
const child = require("child_process");
const request = require("request");



const __cwd = process.cwd();


const get_file_hash = (file_path) => {
    const shaSum = child.execSync(`shasum -b -a 512 libs/${file_path} | awk '{ print $1 }' | xxd -r -p | base64`);
    return "sha512-" + shaSum.slice(0, shaSum.length - 1).toString().replace(/(\r\n|\n|\r)/gm, "");
}



if (process.argv[2] == "pack") {

    const type = process.argv[3] || "dev"; // dev or prod

    const handle_library_file = (folder_name) => {
        let file_size = 0;
        let sri = "";
        let location = "";
        const libJSON = JSON.parse(fs.readFileSync(path.join(__cwd, "libs", folder_name, "lib.json")).toString());
        (type == "dev" ? libJSON.devFiles : libJSON.files).forEach((jsFile) => {
            if (jsFile.file.indexOf("index") !== -1 && jsFile.file.indexOf(".js") !== -1) {
                file_size += jsFile.sizeKB;
                sri = jsFile.sri;
                location = `"${folder_name}": "${folder_name}/${jsFile.file}",\n`;
            }
        });
        return [file_size, sri, location];
    };

    let new_pack_file = `
(function() {
    var __counter = 0;
    var __require = setInterval(function() {

        if (__counter > 60 * 3) { // wait 3 seconds
            clearInterval(__require);
            console.log("Packer failed to load!")
        };

        if (require) {
            clearInterval(__require);
            _amd_packer_config();
        }
    }, 16);

    function _amd_packer_config() {
        requirejs.config({
            baseUrl: 'libs',
            deps: ['app'],
            paths: {
`;

    let hashes = {};
    let sizes = 0;
    
    // load libs
    let files = fs.readdirSync("libs");

    for (let i in files) {
        const file = files[i];
        const isDir = fs.fstatSync(fs.openSync(path.join(__cwd, "libs", file))).isDirectory();
        const first_char = Array.from(file)[0];

        if (isDir && first_char != "@") {
            const [file_size, sri, location] = handle_library_file(file);
            sizes += file_size;
            hashes[file] = sri;
            new_pack_file += location;
        }

        if (isDir && first_char == "@") {
            const nested_files = fs.readFileSync(path.join(__cwd, "libs", file));
            for (let k in nested_files) {
                const nfile = nested_files[k];
                const isDir = fs.fstatSync(fs.openSync(path.join(__cwd, "libs", file, nfile))).isDirectory();

                if (isDir) {
                    const [file_size, sri, location] = handle_library_file(path.join(file, nfile));
                    sizes += file_size;
                    hashes[path.join(file, nfile)] = sri;
                    new_pack_file += location;
                }
            }
        }
    }

    // load app
    files = fs.readdirSync(".");

    for (let i in files) {
        const app_file = type == "dev" ? "app.js" : "app.min.js";
        if (app_file == files[i]) {
            const sri = get_file_hash(path.join("..", app_file));
            hashes["app"] =  sri;
            new_pack_file += `"app": "../${app_file}"`;
        }
    }

    new_pack_file += `
            },
            onNodeCreated: function(node, config, module, path) {
                var sri = sri_obj[module];

                if (sri) {
                    node.setAttribute('integrity', sri);
                    node.setAttribute('crossorigin', 'anonymous');
                } else {
                    console.log("Security error, no integrity found for module:", module);
                }

            }
        });
    }

    var sri_obj = ${JSON.stringify(hashes, null, 4)};
})();
    `;

    fs.writeFileSync(path.join(__cwd, "libs", "pack.js"), new_pack_file.trim());

    if (type == "dev") {
        if (!fs.existsSync(path.join(__cwd, "libs", "require.js"))) {
            request('https://requirejs.org/docs/release/2.3.6/comments/require.js').pipe(fs.createWriteStream(path.join(__cwd, "libs", "require.js")));
        }
    
    } else {
        child.execSync(`./node_modules/.bin/minify ${path.join(__cwd, "libs", "pack.js")} > ${path.join(__cwd, "libs", "pack.min.js")}`, {cwd: __dirname});
        fs.unlinkSync(path.join(__cwd, "libs", "pack.js"));

        if (!fs.existsSync(path.join(__cwd, "libs", "require.min.js"))) {
            request('https://requirejs.org/docs/release/2.3.6/minified/require.js').pipe(fs.createWriteStream(path.join(__cwd, "libs", "require.min.js")));
        }
    
    }

    const shasum = get_file_hash(type == "dev" ? "pack.js" : "pack.min.js");
    const shasumRequire = get_file_hash(type == "dev" ? "require.js" : "require.min.js");


    console.log("Completed!");
    console.log(`Total application and library size: ${Math.round(sizes * 10) / 10}kb`)
    console.log("Paste this into index.html:");
    console.log("");
    console.log(`<script async integrity="${shasumRequire}" crossorigin="anonymous" src="libs/require.min.js"></script>`);
    console.log(`<script async integrity="${shasum}" crossorigin="anonymous" src="libs/pack.min.js">></script>`);

    return;

}

if (process.argv[2] == "compile") {

    const package = process.argv[3];

    const package_path = package.split("/").filter(f => f && f.length);

    const full_path = (partial_path) => path.join(__cwd, "libs", partial_path.join(path.sep));

    const package_root = path.join(__cwd, "libs", package);

    child.execSync(`npm install ${package}`, { cwd: __cwd });
    try {
        child.execSync(`npm install @types/${package}`, { cwd: __cwd });
    } catch (e) { }

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
            const prod = child.spawn(`./node_modules/.bin/webpack-cli`, [`--progress`, `--config`, `webpack.config.prod.5.js`, `--env`, `cwd::${Buffer.from(__cwd).toString('base64')}`, `type=prod`, `mod=${package}`], {
                cwd: __dirname,
                detached: true,
                stdio: "inherit"
            });

            prod.on('exit', res);
        });

        // non minified build
        await new Promise((res, rej) => {
            const prod = child.spawn(`./node_modules/.bin/webpack-cli`, [`--progress`, `--config`, `webpack.config.prod.5.js`, `--env`, `cwd::${Buffer.from(__cwd).toString('base64')}`, `type=dev`, `mod=${package}`], {
                cwd: __dirname,
                detached: true,
                stdio: "inherit"
            });

            prod.on('exit', res);
        });

        const version = child.execSync(`npm view ${package} version`).toString();

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
                {"file": "index.min.js", "sri": "${get_file_hash(`${package}/index.min.js`)}", "sizeKB": ${sizeProd / 1000}}
            ],
            "devFiles": [
                {"file": "index.js", "sri": "${get_file_hash(`${package}/index.js`)}", "sizeKB": ${sizeDev / 1000}}
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
            fs.rmSync(path.join(__cwd, "libs", package, "node_modules"), { recursive: true });
        } catch (e) {

        }

        child.execSync(`npm uninstall ${package}`, { cwd: __cwd });
        try {
            child.execSync(`npm uninstall @types/${package}`, { cwd: __cwd });
        } catch (e) { }


    })()


    console.log("Compilation Finished");
    return;

}