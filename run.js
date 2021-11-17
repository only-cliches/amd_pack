#!/usr/bin/env node

const path = require("path");
const fs = require("fs");
const child = require("child_process");
const request = require("request");
const md5 = require("md5");


const __cwd = process.cwd();


const get_file_hash = (file_path) => {
    const shaSum = child.execSync(`shasum -b -a 512 libs/${file_path} | awk '{ print $1 }' | xxd -r -p | base64`);
    return "sha512-" + shaSum.slice(0, shaSum.length - 1).toString().replace(/(\r\n|\n|\r)/gm, "");
}



if (process.argv[2] == "pack") {

    const type = process.argv[3] || "dev"; // dev or prod

    let start = Date.now();

    if (type == "dev") {
        console.log("BUNDLING FOR DEVELOPMENT");
    } else {
        console.log("BUNDLING FOR PRODUCTION");
    }

    const write_html = (() => {
        for (let i in process.argv) {
            if (process.argv[i].indexOf("html=") !== -1) {
                return process.argv[i].split("=").pop();
            }
        }
        return "";
    })();

    const cdn_url = (() => {
        for (let i in process.argv) {
            if (process.argv[i].indexOf("cdn=") !== -1) {
                return process.argv[i].split("=").pop();
            }
        }
        return "";
    })();

    
    let paths = {};

    let hashes = {};
    let sizes = 0;

    let styles = {};


    // load libs
    const scan_libs = (root_dir, other_dirs) => {
        let files = fs.readdirSync(path.join(root_dir, ...other_dirs));
        for (let i in files) {
            const file = files[i];
            const isDir = fs.fstatSync(fs.openSync(path.join(root_dir, ...other_dirs, file))).isDirectory();
            if (isDir) {
                scan_libs(root_dir, [...other_dirs, file]);
            } else if (file == "amd_lib.json") {

                console.log(`Bundling library ${path.join("libs", ...other_dirs)}`);
                const libJSON = JSON.parse(fs.readFileSync(path.join(__cwd, "libs", ...other_dirs, "amd_lib.json")).toString());
                const key = path.join(...other_dirs);
                styles[key] = [];
                libJSON.files.forEach((file) => {
                    // get js file from this library
                    if ((type == "dev" && file.type == "script_dev") || (type == "prod" && file.type == "script_prod")) {
                        sizes += file.sizeKB;
                        hashes[key] = file.sri;
                        paths[key] = `libs/${key}/${file.file}`.replace(".js", "")
                    }
                    // add styles
                    if (file.type == "style") {
                        styles[key].push({
                            sri: file.sri,
                            file: `libs/${key}/${file.file}`
                        });
                    }
                })
            }
        }

    };
    scan_libs(path.join(__cwd, "libs"), []);

    // load app files
    const scan_files = (root_dir, other_dirs) => {
        try {
            let files = fs.readdirSync(path.join(root_dir, ...other_dirs));
            for (let i in files) {
                const file = files[i];
                const isDir = fs.fstatSync(fs.openSync(path.join(root_dir, ...other_dirs, file))).isDirectory();

                if (isDir) {
                    scan_files(root_dir, [...other_dirs, file]);
                } else if (file.indexOf(".js") !== -1 && file.indexOf(".min.") == -1) { // not a minified file
                    let hash_key = path.join(...other_dirs, file.replace('.js', ''));

                    if (type == "prod") {

                        const file_hash = md5(fs.readFileSync(path.join(root_dir, ...other_dirs, file)).toString());
                        const new_name = file.replace(".js", `.min.${file_hash}.js`);

                        if (!fs.existsSync(path.join(root_dir, ...other_dirs, file.replace(".js", `.min.${file_hash}.js`)))) {
                            console.log(`Minifying: ${path.join(...other_dirs, file)} -> ${path.join(...other_dirs, file.replace(".js", `.min.${file_hash}.js`))}`);
                            child.execSync(`./node_modules/.bin/minify ${path.join(root_dir, ...other_dirs, file)} > ${path.join(root_dir, ...other_dirs, file.replace(".js", ".min.js"))}`, {cwd: __dirname});
                            const contents = fs.readFileSync(path.join(root_dir, ...other_dirs, file.replace(".js", ".min.js"))).toString();
                            hashes[hash_key] = get_file_hash(path.join("..", ...other_dirs, file.replace(".js", ".min.js")));
                            sizes += contents.length / 1000;
                            fs.renameSync(path.join(root_dir, ...other_dirs, file.replace(".js", ".min.js")), path.join(root_dir, ...other_dirs, new_name));
                            paths[hash_key] = path.join(...other_dirs, new_name.replace(".js", ""));
                        } else {
                            console.log(`Cached: ${path.join(...other_dirs, file)} -> ${path.join(...other_dirs, file.replace(".js", `.min.${file_hash}.js`))}`);
                            hashes[hash_key] = get_file_hash(path.join("..", ...other_dirs, file.replace(".js", `.min.${file_hash}.js`)));
                            paths[hash_key] = path.join(...other_dirs, new_name.replace(".js", ""));
                            sizes += fs.readFileSync(path.join(root_dir, ...other_dirs, file.replace(".js", `.min.${file_hash}.js`))).length / 1000;
                        }


                    } else {
                        sizes += fs.readFileSync(path.join(root_dir, ...other_dirs, file)).toString().length / 1000;
                        hashes[hash_key] = get_file_hash(path.join("..", ...other_dirs, file));
                    }
                }
            }
        } catch (e) {
           
        }
    };
    scan_files(__cwd, ["pages"]);
    scan_files(__cwd, ["components"]);
    scan_files(__cwd, ["utilities"]);
    scan_files(__cwd, ["store"]);

    const removeEmptyKeys = (obj) => {
        if (Object.keys(obj).length) {
            let new_obj = {};
            Object.keys(obj).forEach((key) => {
                if (obj[key] && obj[key].length) {
                    new_obj[key] = obj[key];
                }
            });

            return new_obj;
        }
        return {};
    };

    // load app.js
    let files = fs.readdirSync(__cwd);

    const app_file = "app.js";
    let found_app = false;

    for (let i in files) {
        if (app_file == files[i]) {
            found_app = true;

            if (type == "prod") {
                const app_hash = md5(fs.readFileSync(path.join(__cwd, "app.js")).toString());

                if (!fs.existsSync(path.join(__cwd, `app.min.${app_hash}.js`))) {
                    console.log(`Minifying: app.js -> app.min.${app_hash}.js`);
                    child.execSync(`./node_modules/.bin/minify ${path.join(__cwd, "app.js")} > ${path.join(__cwd, "app.min.js")}`, {cwd: __dirname});
                    const sri = get_file_hash(path.join("..", "app.min.js"));
                    hashes["app"] =  sri;
                    const contents = fs.readFileSync(path.join(__cwd, "app.min.js")).toString();
                    sizes += contents.length / 1000;
                    paths["app"] = `./app.min.${app_hash}`;
                    fs.renameSync(path.join(__cwd, "app.min.js"), path.join(__cwd, `app.min.${app_hash}.js`));
                } else {
                    console.log(`Cached: app.js -> app.min.${app_hash}.js`);
                    const sri = get_file_hash(path.join("..", `app.min.${app_hash}.js`));
                    hashes["app"] =  sri;
                    sizes += fs.readFileSync(path.join(__cwd, `app.min.${app_hash}.js`)).toString().length / 1000;
                    paths["app"] = `./app.min.${app_hash}`;
                }


            } else {
                paths["app"] = `./${app_file.replace(".js", "")}`;
                sizes += fs.readFileSync(path.join(__cwd, app_file)).toString().length / 1000;
            }
            
        }
    }

    if (found_app == false) {
        console.error(`Unable to find ${app_file} in root!`);
        process.exit();
    }

    let new_pack_file = `
    (function() {
        var __counter = 0;
        var __loading;
        var __require = setInterval(function() {`;
        
        if (type == "dev") {
            new_pack_file += `
            if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
                // do nothing
            } else {
                console.error("Please use amd_pack in production mode, this build isn't secure!");
                clearInterval(__require);
                return;
            }
            `;
        }

        new_pack_file += `

            if (__counter > 60 * 3) { // wait 3 seconds
                clearInterval(__require);
                console.log("Packer failed to load!")
            };

            if (typeof require !== undefined && typeof requirejs === 'function') {
                clearInterval(__require);
                _amd_packer_config();
            }

            __counter += 1;

        }, 16);

        function _amd_packer_config() {
            requirejs.config({
                baseUrl: "${cdn_url}",
                deps: ['app'],
                callback: function() {
                    var __loading = document.getElementById("amd_loader");
                    if (__loading) {
                        var hide = __loading.getAttribute("data-hide");
                        if (hide) {
                            var style = hide.split(":");
                            __loading.style[style[0]] = style[1];
                        } else {
                            __loading.style.display = "none";
                        }
                        
                    }
                },
                paths: ${JSON.stringify(paths, null, 4)},
                onNodeCreated: function(node, config, module, path) {
                    var sri = sri_obj[module];

                    if (sri) {
                        node.setAttribute('integrity', sri);
                        node.setAttribute('crossorigin', 'anonymous');
                    } else {
                        ${type == "prod" ? `console.log("Security error, no integrity found for module:", module)` : ''};
                    }

                    if (style_obj[module] && style_obj[module].length) {
                        style_obj[module].forEach(function(style) {
                            var elem = document.createElement("link");
                            elem.setAttribute("rel", "stylesheet");
                            elem.setAttribute("href", style.file);
                            ${type == "prod" ? `elem.setAttribute("integrity", style.sri);` : ""}
                            ${type == "prod" ? `elem.setAttribute("crossorigin", "anonymous");` : ""}
                            document.head.appendChild(elem);
                        });
                    }

                }
            });
        }

        var sri_obj = ${type == "prod" ? JSON.stringify(hashes, null, 4) : "{}"};
        var style_obj = ${JSON.stringify(removeEmptyKeys(styles), null, 4)};
    })();`.trim();

    

    fs.writeFileSync(path.join(__cwd, "libs", "pack.js"), new_pack_file.trim());

    if (type == "dev") {
        if (!fs.existsSync(path.join(__cwd, "libs", "require.js"))) {
            request('https://requirejs.org/docs/release/2.3.6/comments/require.js').pipe(fs.createWriteStream(path.join(__cwd, "libs", "require.js")));
            child.execSync("sleep 0.5");
        }
    
    } else {

        child.execSync(`./node_modules/.bin/minify ${path.join(__cwd, "libs", "pack.js")} > ${path.join(__cwd, "libs", "pack.min.js")}`, {cwd: __dirname});
        //fs.unlinkSync(path.join(__cwd, "libs", "pack.js"));

        if (!fs.existsSync(path.join(__cwd, "libs", "require.min.js"))) {
            request('https://requirejs.org/docs/release/2.3.6/minified/require.js').pipe(fs.createWriteStream(path.join(__cwd, "libs", "require.min.js")));
            child.execSync("sleep 0.5");
        }
    
    }

    const shasum = get_file_hash(type == "dev" ? "pack.js" : "pack.min.js");
    const shasumRequire = get_file_hash(type == "dev" ? "require.js" : "require.min.js");

    let pack_file = "libs/pack.js";

    if (type == "prod") {
        const file_hash = md5(fs.readFileSync(path.join(__cwd, "libs", "pack.min.js")).toString());
        fs.renameSync(path.join(__cwd, "libs", "pack.min.js"), path.join(__cwd, "libs", `pack.min.${file_hash}.js`));
        pack_file = `libs/pack.min.${file_hash}.js`;
    }

    console.log(`Writing package file ${pack_file}`);
    console.log("");

    console.log(`Completed in ${Math.round((Date.now() - start) / 100) / 10} seconds!`);
    console.log(`Total application, library & styles size: ${Math.round(sizes * 10) / 10}kb`);
    console.log("");

    let finished = `<script async ${type == "prod" ? `integrity="${shasumRequire}" crossorigin="anonymous"` : ""} src="${cdn_url}/libs/require${type == "prod" ? ".min" : ""}.js"></script>\n`;
    finished += `<script async ${type == "prod" ? `integrity="${shasum}" crossorigin="anonymous"` : ""} src="${cdn_url}/${pack_file}"></script>\n`;
    
    if (write_html && fs.existsSync(write_html)) {
        let html_file = fs.readFileSync(write_html).toString();
        const start_template = html_file.indexOf("<!-- LOADER -->");
        const end_template = html_file.indexOf("<!-- /LOADER -->");
        if (start_template !== -1 && end_template !== -1) {
            let split_file = Array.from(html_file);
            split_file.splice(start_template + 16, end_template - (start_template + 16), ...Array.from(finished));
            fs.writeFileSync(write_html, split_file.join(""));
            console.log(`Written to ${write_html}`);
        } else {
            console.log("Unable to find index HTML file, please paste this into index.html:");
            console.log("");
            console.log(finished);     
        }

    } else {
        console.log("Paste this into index.html:");
        console.log("");
        console.log(finished);      
    }


    return;

}

if (process.argv[2] == "build") {

    const package = process.argv[3];

    const bundle_deps = (() => {
        for (let i in process.argv) {
            if (process.argv[i].indexOf("bundle=") !== -1) {
                return process.argv[i].split("=").pop().split(",");
            }
        }
        return [];
    })();

    const index_file = (() => {
        for (let i in process.argv) {
            if (process.argv[i].indexOf("index=") !== -1) {
                return process.argv[i].split("=").pop();
            }
        }
        return "";
    })();

    const module_name = (() => {
        for (let i in process.argv) {
            if (process.argv[i].indexOf("name=") !== -1) {
                return process.argv[i].split("=").pop();
            }
        }
        return "";
    })();

    const styles = (() => {
        for (let i in process.argv) {
            if (process.argv[i].indexOf("styles=") !== -1) {
                return process.argv[i].split("=").pop().split(",");
            }
        }
        return [];
    })();

    const package_path = package.split("/").filter(f => f && f.length);

    const full_path = (partial_path) => path.join(__cwd, "libs", partial_path.join(path.sep));

    const package_root = path.join(__cwd, "libs", module_name || package);

    child.execSync(`npm install ${package}`, { cwd: __cwd });

    const copy_types = (scan_dir, subdirs, extension, recursive) => {

        let copy = [];

        try {
            const files = fs.readdirSync(path.join(scan_dir, ...subdirs));
            try {
                fs.mkdirSync(path.join(package_root, ...subdirs));
            } catch (e) { }
            for (key in files) {
                if (files[key].indexOf(extension) !== -1) {
                    fs.copyFileSync(path.join(scan_dir, ...subdirs, files[key]), path.join(package_root, ...subdirs, files[key]));
                    copy.push(path.join(package_root, ...subdirs, files[key]));
                } else if (fs.fstatSync(fs.openSync(path.join(scan_dir, ...subdirs, files[key]))).isFile() == false && recursive) {
                    copy.concat(copy_types(scan_dir, [...subdirs, files[key]], extension, true));
                }
            }
        } catch(e) {
            
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
        if (fs.existsSync(entry) == false && index_file == "") {
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
            const prod = child.spawn(`./node_modules/.bin/webpack-cli`, [`--progress`, `--config`, `webpack.config.prod.5.js`, `--env`, `name::${Buffer.from(module_name).toString('base64')}`, `index::${Buffer.from(index_file).toString('base64')}`, `bundle::${Buffer.from(JSON.stringify(bundle_deps)).toString('base64')}`, `cwd::${Buffer.from(__cwd).toString('base64')}`, `type=prod`, `mod=${package}`], {
                cwd: __dirname,
                detached: true,
                stdio: "inherit"
            });

            prod.on('exit', res);
        });

        // non minified build
        await new Promise((res, rej) => {
            const prod = child.spawn(`./node_modules/.bin/webpack-cli`, [`--progress`, `--config`, `webpack.config.prod.5.js`, `--env`, `name::${Buffer.from(module_name).toString('base64')}`, `index::${Buffer.from(index_file).toString('base64')}`, `bundle::${Buffer.from(JSON.stringify(bundle_deps)).toString('base64')}`, `cwd::${Buffer.from(__cwd).toString('base64')}`, `type=dev`, `mod=${package}`], {
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

        const prodJSFile = fs.readFileSync(path.join(__cwd, "libs", module_name || package, "index.min.js")).toString();
        const prodHash = md5(prodJSFile);
        const sizeProd = prodJSFile.length;
        const sizeDev = fs.readFileSync(path.join(__cwd, "libs", module_name || package, "index.js")).toString().length;

        const prodFileName = `index.${prodHash}.min.js`;
        fs.renameSync(path.join(__cwd, "libs", module_name || package, "index.min.js"), path.join(__cwd, "libs", module_name || package, prodFileName));

        let style_files = [];
        // copy styles
        for (let k in styles) {
            const file_name = styles[k];
            if (fs.existsSync(path.join(__cwd, "node_modules", package, file_name))) {
                const file_contents = fs.readFileSync(path.join(__cwd, "node_modules", package, file_name)).toString();

                fs.copyFileSync(path.join(__cwd, "node_modules", package, file_name), path.join(__cwd, "libs", module_name || package, file_name.split(path.sep).pop()));
    
                style_files.push({size: file_contents.length / 1000, file: file_name.split(path.sep).pop(), sri: get_file_hash(path.join( module_name || package, file_name.split(path.sep).pop()))});
            }
        }

        // copy css files
        // let css_files = copy_types(path.join(__cwd, "node_modules", module_name || package), [], ".css", false);

        fs.writeFileSync(path.join(__cwd, "libs", module_name || package, "amd_lib.json"), `
        {
            "api": 1,
            "name": "${module_name || package}",
            "description": "${package_json.description}",
            "author": ${package_json.author == undefined ? '""' : JSON.stringify(package_json.author)},
            "version": "${version.slice(0, version.length - 1)}",
            "repo": ${JSON.stringify(package_json.repository)},
            "homepage": "${package_json.homepage}",
            "keywords": ${JSON.stringify(package_json.keywords || [])},
            "license": "${package_json.license}",
            "dependencies": ${JSON.stringify(JSON.parse(fs.readFileSync(path.join(__cwd, "__deps.json")).toString()), null, 4).replace(/    /img, "        ").replace("}", "    }")},
            "files": [
                {"type": "script_prod", "file": "${prodFileName}", "sri": "${get_file_hash(`${module_name || package}/${prodFileName}`)}", "sizeKB": ${sizeProd / 1000}},
                {"type": "script_dev", "file": "index.js", "sri": "${get_file_hash(`${module_name || package}/index.js`)}", "sizeKB": ${sizeDev / 1000}}${style_files.length ? "," : ""}
                ${style_files.map(style => `{"type": "style", "file": "${style.file}", "sri": "${style.sri}", "sizeKB": ${style.size}}`).join(",\n")}
            ]
        }
        `.trim());

        try {
            fs.unlinkSync(path.join(__cwd, "__deps.json"));
        } catch (e) {

        }

        if (has_gen_entry) {
            fs.unlinkSync(path.join(__cwd, `/node_modules/${ module_name ||package}/index.js`));
        }


        // Checks for TS files and copy them over
        // const types_root = path.join(__cwd, "node_modules", "@types", module_name || package);

        // // check for ts files
        // if (fs.existsSync(types_root)) {
        //     copy_types(types_root, [], ".d.ts", true);
        // } else { // try to find types in node_modules
        //     copy_types(path.join(__cwd, "node_modules", module_name || package), [], ".d.ts", true);
        // }

        // copy eot, svg, ttf, and woff files over
        copy_types(path.join(__cwd, "node_modules", module_name || package), [], ".eot", true);
        copy_types(path.join(__cwd, "node_modules", module_name || package), [], ".woff", true);
        copy_types(path.join(__cwd, "node_modules", module_name || package), [], ".svg", true);
        copy_types(path.join(__cwd, "node_modules", module_name || package), [], ".ttf", true);

        // sometimes node_modules interior directory gets coppied over, remove it if it's there
        try {
            fs.rmSync(path.join(__cwd, "libs", package, "node_modules"), { recursive: true });
        } catch (e) {

        }


    })()


    console.log("Compilation Finished");
    return;

}