#!/usr/bin/env node

const path = require("path");
const fs = require("fs");
const child = require("child_process");
const request = require("request");
const XXHash = require('xxhash');
const filesize = require("filesize");
const { gzip, ungzip } = require('node-gzip');
const { sep } = require("path");

const __cwd = process.cwd();


const get_file_hash = (file_path) => {
    const shaSum = child.execSync(`shasum -b -a 512 'libs/${file_path}' | awk '{ print $1 }' | xxd -r -p | base64`);
    return "sha512-" + shaSum.slice(0, shaSum.length - 1).toString().replace(/(\r\n|\n|\r)/gm, "");
}

// for FILE in *.js; do echo -e "amd_pack build react-bootstrap name=react-bootstrap/$FILE index=esm/$FILE"; done
if (process.argv[2] == "list") {

    const package_name = process.argv[3];
    const scan_dir = process.argv[4];

    const scan = (dir) => {
        const files = fs.readdirSync(dir);

        for (let i = 0; i < files.length; i++) {
            const f = files[i];
            if (fs.statSync(path.join(dir, f)).isDirectory()) {
                scan(path.join(dir, f));
            } else {
                let file_name = path.join(dir, f);
                if (f.indexOf(".js") !== -1 && f.indexOf(".flow") === -1) {
                    file_name = file_name.slice(file_name.indexOf(package_name) + package_name.length + 1);
                    const mod_name = package_name + "/" + file_name;
                    console.log(`and_pack build ${package_name} name=${mod_name.replace(".js", "")} index=${file_name}`);
                }

            }
        }
    };

    scan(path.join(__cwd, scan_dir));
    return;
}


if (process.argv[2] == "pack") {

    (async () => {

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
        let gzip_size = 0;

        let styles = {};


        // load libs
        const scan_libs = async (root_dir, other_dirs) => {
            let files = fs.readdirSync(path.join(root_dir, ...other_dirs));
            for (let i in files) {
                const file = files[i];
                const isDir = fs.fstatSync(fs.openSync(path.join(root_dir, ...other_dirs, file))).isDirectory();
                if (isDir) {
                    await scan_libs(root_dir, [...other_dirs, file]);
                } else if (file == "amd_lib.json") {
                    console.log(`Bundling library ${path.join("libs", ...other_dirs)}`);
                    const libJSON = JSON.parse(fs.readFileSync(path.join(__cwd, "libs", ...other_dirs, "amd_lib.json")).toString());
                    const key = path.join(...other_dirs);
                    styles[key] = [];
                    const use_files = (() => {
                        if (type == 'prod') {
                            return libJSON.prod_files;
                        } else {
                            return libJSON.dev_files;
                        }
                    })();
                    for (let j = 0; j < use_files.length; j++) {
                        const file = use_files[j];
                        // console.log(file);
                        // get js file from this library
                        if (file.type == "script") {
                            sizes += file.size;
                            gzip_size += file.gzipSize || 0;
                            hashes[key] = file.sri;
                            paths[key] = `/libs/${key}/${file.file}`.replace(".js", "")
                        }
                        // add styles
                        if (file.type == "style") {
                            sizes += file.size;
                            gzip_size += file.gzipSize || 0;
                            styles[key].push({
                                sri: file.sri,
                                file: `/libs/${key}/${file.file}`
                            });
                        }
                    }
                }
            }

        };
        await scan_libs(path.join(__cwd, "libs"), []);

        // load app files
        const scan_files = async (root_dir, other_dirs) => {
            try {
                let files = fs.readdirSync(path.join(root_dir, ...other_dirs));
                for (let i in files) {
                    const file = files[i];
                    const isDir = fs.fstatSync(fs.openSync(path.join(root_dir, ...other_dirs, file))).isDirectory();

                    if (isDir) {
                        await scan_files(root_dir, [...other_dirs, file]);
                    } else if (file.indexOf(".js") !== -1 && file.indexOf(".min.") == -1 && file.indexOf(".map") === -1) { // not a minified file
                        let hash_key = path.join(...other_dirs, file.replace('.js', ''));

                        if (type == "prod") {

                            const app_file = fs.readFileSync(path.join(root_dir, ...other_dirs, file));
                            const hasher = new XXHash(0xCAFEBABE);
                            hasher.update(app_file);
                            const file_hash = hasher.digest().toString(36);
                            const new_name = file.replace(".js", `.min.${file_hash}.js`);

                            if (!fs.existsSync(path.join(root_dir, ...other_dirs, file.replace(".js", `.min.${file_hash}.js`)))) {
                                console.log(`Minifying: ${path.join(...other_dirs, file)} -> ${path.join(...other_dirs, file.replace(".js", `.min.${file_hash}.js`))}`);
                                child.execSync(`./node_modules/.bin/minify '${path.join(root_dir, ...other_dirs, file)}' > '${path.join(root_dir, ...other_dirs, file.replace(".js", ".min.js"))}'`, { cwd: __dirname });
                                const contents = fs.readFileSync(path.join(root_dir, ...other_dirs, file.replace(".js", ".min.js"))).toString();
                                hashes[hash_key] = get_file_hash(path.join("..", ...other_dirs, file.replace(".js", ".min.js")));
                                fs.renameSync(path.join(root_dir, ...other_dirs, file.replace(".js", ".min.js")), path.join(root_dir, ...other_dirs, new_name));
                                paths[hash_key] = "/" + path.join(...other_dirs, new_name.replace(".js", ""));
                            } else {
                                console.log(`Cached: ${path.join(...other_dirs, file)} -> ${path.join(...other_dirs, file.replace(".js", `.min.${file_hash}.js`))}`);
                                hashes[hash_key] = get_file_hash(path.join("..", ...other_dirs, file.replace(".js", `.min.${file_hash}.js`)));
                                paths[hash_key] = "/" + path.join(...other_dirs, new_name.replace(".js", ""));
                            }

                            const file_data = fs.readFileSync(path.join(root_dir, ...other_dirs, new_name));
                            sizes += file_data.length;
                            gzip_size += await (await gzip(file_data)).byteLength || 0;

                        } else {
                            sizes += fs.readFileSync(path.join(root_dir, ...other_dirs, file)).toString().length;
                            hashes[hash_key] = get_file_hash(path.join("..", ...other_dirs, file));
                        }
                    }
                }
            } catch (e) {

            }
        };

        await scan_files(__cwd, ["pages"]);
        await scan_files(__cwd, ["components"]);
        await scan_files(__cwd, ["utilites"]);
        await scan_files(__cwd, ["store"]);

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

                    let app_file = fs.readFileSync(path.join(__cwd, "app.js"));
                    const hasher = new XXHash(0xCAFEBABE);
                    hasher.update(app_file);
                    const app_hash = hasher.digest().toString(36);
                    const new_name = `app.min.${app_hash}.js`;

                    if (!fs.existsSync(path.join(__cwd, new_name))) {
                        console.log(`Minifying: app.js -> app.min.${app_hash}.js`);
                        child.execSync(`./node_modules/.bin/minify '${path.join(__cwd, "app.js")}' > '${path.join(__cwd, "app.min.js")}'`, { cwd: __dirname });
                        const sri = get_file_hash(path.join("..", "app.min.js"));
                        hashes["app"] = sri;
                        paths["app"] = `/app.min.${app_hash}`;
                        fs.renameSync(path.join(__cwd, "app.min.js"), path.join(__cwd, new_name));
                    } else {
                        console.log(`Cached: app.js -> app.min.${app_hash}.js`);
                        const sri = get_file_hash(path.join("..", new_name));
                        hashes["app"] = sri;
                        sizes += fs.readFileSync(path.join(__cwd, new_name)).toString().length;
                        paths["app"] = `/app.min.${app_hash}`;
                    }

                    const contents = fs.readFileSync(path.join(__cwd, new_name));
                    sizes += contents.length;
                    gzip_size += await (await gzip(contents)).byteLength || 0;

                } else {
                    paths["app"] = `/${app_file.replace(".js", "")}`;
                    sizes += fs.readFileSync(path.join(__cwd, app_file)).toString().length;
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
                baseUrl: "${cdn_url || "/"}",
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
                        ${type == "prod" ? `console.error("Scurity error, no integrity found for script in module: ", module);` : ''};
                    }

                    if (style_obj[module] && style_obj[module].length) {
                        style_obj[module].forEach(function(style) {
                            var elem = document.createElement("link");
                            elem.setAttribute("rel", "stylesheet");
                            elem.setAttribute("href", style.file);
                            ${type == "prod" ? `
                            if (style.sri) {
                                elem.setAttribute("integrity", style.sri);
                                elem.setAttribute("crossorigin", "anonymous");
                            } else {
                                console.error("Security error, no integrity found for css in module: ", module, style.file);
                            }
                            ` : ""}
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

            child.execSync(`./node_modules/.bin/minify '${path.join(__cwd, "libs", "pack.js")}' > '${path.join(__cwd, "libs", "pack.min.js")}'`, { cwd: __dirname });
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

            let pack_file_contents = fs.readFileSync(path.join(__cwd, "libs", "pack.min.js"));
            const hasher = new XXHash(0xCAFEBABE);
            hasher.update(pack_file_contents);
            const file_hash = hasher.digest().toString(36);

            sizes += pack_file_contents.length;

            fs.renameSync(path.join(__cwd, "libs", "pack.min.js"), path.join(__cwd, "libs", `pack.min.${file_hash}.js`));
            pack_file = `libs/pack.min.${file_hash}.js`;

            gzip_size += await (await gzip(pack_file_contents)).byteLength;

        } else {
            let pack_file_contents = fs.readFileSync(path.join(__cwd, "libs", "pack.js"));
            sizes += pack_file_contents.length;
        }

        console.log(`Writing package file ${pack_file}`);
        console.log("");

        console.log(`Completed in ${Math.round((Date.now() - start) / 100) / 10} seconds!`);
        console.log(`Total application, library & styles size: ${filesize(sizes)}`);
        if (type == "prod") {
            console.log(`gzipped: ${filesize(gzip_size)}`);
        }
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
    })()
}

const async_process = (...args) => {
    return new Promise((res, rej) => {
        const spawn = child.spawn(...args);

        spawn.on('error', (err) => {
            rej(err);
        });

        let outdata = "", outerr = "";

        spawn.stdout.on('data', (data) => {
            outdata += data;
        });

        spawn.stderr.on('data', (data) => {
            outerr += data;
        });

        spawn.on('close', (code) => {
            if (code !== 0) {
                rej(outerr);
            } else {
                res(outdata);
            }
        });
    });
}

const npm_install = async (module, stop_on_failure) => {
    return new Promise((res, rej) => {
        const spawn = child.spawn(`npm`, [`install`, module], {
            cwd: __dirname,
            detached: true,
        });

        spawn.on('error', (err) => {
            rej(err);
        });

        let outdata = "", outerr = "";

        spawn.stdout.on('data', (data) => {
            outdata += data;
        });

        spawn.stderr.on('data', (data) => {
            outerr += data;
        });

        spawn.on('close', (code) => {
            if (code !== 0 && stop_on_failure == true) {
                console.log("Error intalling package...");
                console.log(outdata);
                console.error(outerr);
                process.exit();
            } else {
                res(outdata);
            }
        });
    });
};


const install_package = async (package, index_file, output_dir) => {
    await npm_install(package, true);
    await npm_install(`@types/${package}`, false);

    let current_path = __cwd.split(path.sep);
    let found_node_modules = false;
    while (found_node_modules == false && current_path.length) {
        if (fs.existsSync(path.join(path.sep, ...current_path, "node_modules"))) {
            found_node_modules = true;
        } else {
            current_path.pop();
        }
    }

    if (found_node_modules == false) {
        console.log("Unable to find node_modules, quitting!");
        process.exit();
    }

    if (!fs.existsSync(path.join(__cwd, output_dir))) {
        fs.mkdirSync(path.join(__cwd, output_dir));
    }

    if (!fs.existsSync(path.join(__cwd, output_dir, ...package.split("/")))) {
        fs.mkdirSync(path.join(__cwd, output_dir, ...package.split("/")));
    }

    const package_path = path.join(path.sep, ...current_path, "node_modules", ...package.split("/"));

    const package_json = JSON.parse(fs.readFileSync(path.join(package_path, "package.json")));

    const version = package_json.version;

    const entry = path.join(package_path, `${index_file || package_json.main || "index.js"}`);

    const indexJSFile = fs.readFileSync(entry);
    const hasher = new XXHash(0xCAFEBABE);
    hasher.update(indexJSFile);
    const hash = hasher.digest().toString(16);

    const build_module = async (mode) => {
        try {
            const filename = `${version}_${hash}${mode == "prod" ? ".min" : ""}.js`;

            const target_file = path.join(__cwd, output_dir, ...package.split("/"), filename);
        
            if (fs.existsSync(target_file)) {
                return;
            }

            const webpack_result = await async_process(`./node_modules/.bin/webpack-cli`, [
                `--json`,
                `--config`, `webpack.config.prod.5.1.js`,
                `--env`, `NODE_ENV=${mode == "dev" ? "development" : "production"}`,
                `config::${Buffer.from(JSON.stringify({
                    library: package,
                    path: path.join(__cwd, output_dir, package),
                    filename: filename,
                    entry: entry,
                    mode: mode
                })).toString('base64')}`,
            ], {
                cwd: __dirname,
                detached: true
            });

            const output_data = JSON.parse(webpack_result);

            const size = output_data.namedChunkGroups.main.assets[0].size;

            fs.writeFileSync(path.join(__cwd, output_dir, "webpack.json"), JSON.stringify(output_data, null, 4));

            let dependencies = [];
            output_data.modules.forEach((module) => {
                if (module.name.indexOf("external ") !== -1) {
                    const name = module.name.replace('external ', "").replace(/\"/gmi, "");
                    dependencies.push(name);
                }
            });

            console.log(`Built ${path.join(output_dir, package, filename)} (${humanFileSize(size)}) in ${output_data.time}ms`);   
            if (dependencies.length > 0) {
                console.log("Checking dependencies...");
                for (let i = 0; i < dependencies.length; i++) {
                    await install_package(dependencies[i], "", output_dir);
                }
            }

        } catch(e) {
            console.error(e);
        }
    }

    await build_module("prod");
    await build_module("dev");
};

if (process.argv[2] == "install") {

    const package = process.argv[3];


    const index_file = (() => {
        for (let i in process.argv) {
            if (process.argv[i].indexOf("index=") !== -1) {
                return process.argv[i].split("=").pop();
            }
        }
        return "";
    })();

    const output_dir = (() => {
        for (let i in process.argv) {
            if (process.argv[i].indexOf("out_dir=") !== -1) {
                return process.argv[i].split("=").pop();
            }
        }
        return "";
    })();

    install_package(package, index_file, output_dir);
}

if (process.argv[2] == "build") {

    const package = process.argv[3];

    const local_modules = (() => {
        for (let i in process.argv) {
            if (process.argv[i].indexOf("local_modules=") !== -1) {
                try {
                    return process.argv[i].split("=").pop().trim();
                } catch (e) {
                    return "";
                }
            }
        }
        return "";
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

    const prod_styles = (() => {
        let result = [];
        for (let i in process.argv) {
            if (process.argv[i].indexOf("prod_style=") !== -1) {
                result.push(process.argv[i].split("=").pop());
            }
        }
        return result;
    })();

    const types = (() => {
        let result = [];
        for (let i in process.argv) {
            if (process.argv[i].indexOf("types=") !== -1) {
                result.push(process.argv[i].split("=").pop());
            }
        }
        return result;
    })();

    const dev_styles = (() => {
        let result = [];
        for (let i in process.argv) {
            if (process.argv[i].indexOf("dev_style=") !== -1) {
                result.push(process.argv[i].split("=").pop());
            }
        }
        return result;
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
        } catch (e) {

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
            const prod = child.spawn(`./node_modules/.bin/webpack-cli`, [`--progress`, `--config`, `webpack.config.prod.5.js`, `--env`, `name::${Buffer.from(module_name).toString('base64')}`, `index::${Buffer.from(index_file).toString('base64')}`, `bundle::${Buffer.from(local_modules).toString('base64')}`, `cwd::${Buffer.from(__cwd).toString('base64')}`, `type=prod`, `mod=${package}`], {
                cwd: __dirname,
                detached: true,
                stdio: "inherit"
            });

            prod.on('exit', res);
        });

        // non minified build
        await new Promise((res, rej) => {
            const prod = child.spawn(`./node_modules/.bin/webpack-cli`, [`--progress`, `--config`, `webpack.config.prod.5.js`, `--env`, `name::${Buffer.from(module_name).toString('base64')}`, `index::${Buffer.from(index_file).toString('base64')}`, `bundle::${Buffer.from(local_modules).toString('base64')}`, `cwd::${Buffer.from(__cwd).toString('base64')}`, `type=dev`, `mod=${package}`], {
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

        const prodJSFile = fs.readFileSync(path.join(__cwd, "libs", module_name || package, "index.min.js"));
        const hasher = new XXHash(0xCAFEBABE);
        hasher.update(prodJSFile);
        const prodHash = hasher.digest().toString(36);

        const sizeProd = prodJSFile.length;
        const sizeProdGzip = await (await gzip(prodJSFile)).byteLength;
        const prodFile = fs.readFileSync(path.join(__cwd, "libs", module_name || package, "index.js"));

        const sizeDev = prodFile.length;
        const sizeDevGzip = await (await gzip(prodFile)).byteLength;

        const prodFileName = `index.${prodHash}.min.js`;
        fs.renameSync(path.join(__cwd, "libs", module_name || package, "index.min.js"), path.join(__cwd, "libs", module_name || package, prodFileName));

        let prod_style_files = [];
        // copy styles
        for (let k in prod_styles) {
            const file_name = prod_styles[k];
            if (fs.existsSync(path.join(__cwd, "node_modules", package, file_name))) {
                const file_contents = fs.readFileSync(path.join(__cwd, "node_modules", package, file_name)).toString();

                fs.copyFileSync(path.join(__cwd, "node_modules", package, file_name), path.join(__cwd, "libs", module_name || package, file_name.split(path.sep).pop()));

                const gzipped = await (await gzip(file_contents)).byteLength;

                prod_style_files.push({ size: file_contents.length, sizeGzip: gzipped, file: file_name.split(path.sep).pop(), sri: get_file_hash(path.join(module_name || package, file_name.split(path.sep).pop())) });
            }
        }

        let dev_style_files = [];
        // copy styles
        for (let k in dev_styles) {
            const file_name = dev_styles[k];
            if (fs.existsSync(path.join(__cwd, "node_modules", package, file_name))) {
                const file_contents = fs.readFileSync(path.join(__cwd, "node_modules", package, file_name)).toString();

                fs.copyFileSync(path.join(__cwd, "node_modules", package, file_name), path.join(__cwd, "libs", module_name || package, file_name.split(path.sep).pop()));

                const gzipped = await (await gzip(file_contents)).byteLength;

                dev_style_files.push({ size: file_contents.length, sizeGzip: gzipped, file: file_name.split(path.sep).pop(), sri: get_file_hash(path.join(module_name || package, file_name.split(path.sep).pop())) });
            }
        }

        fs.writeFileSync(path.join(__cwd, "libs", module_name || package, "amd_lib.json"), `
        {
            "api": 1,
            "name": "${module_name || package}",
            "description": "${(package_json.description || "").replace(/\"/gmi, "'")}",
            "author": ${package_json.author == undefined ? '""' : JSON.stringify(package_json.author)},
            "version": "${version.slice(0, version.length - 1)}",
            "repo": ${JSON.stringify(package_json.repository) || '""'},
            "homepage": "${package_json.homepage}",
            "keywords": ${JSON.stringify(package_json.keywords || [])},
            "license": "${package_json.license}",
            "dependencies": ${JSON.stringify(JSON.parse(fs.readFileSync(path.join(__cwd, "__deps.json")).toString()), null, 4).replace(/    /img, "        ").replace("}", "    }")},
            "prod_files": [
                {"type": "script", "file": "${prodFileName}", "sri": "${get_file_hash(`${module_name || package}/${prodFileName}`)}", "size": ${sizeProd}, "gzipSize": ${sizeProdGzip}}${prod_style_files.length ? "," : ""}
                ${prod_style_files.map(style => `{"type": "style", "file": "${style.file}", "sri": "${style.sri}", "gzipSize": ${style.sizeGzip}, "size": ${style.size}}`).join(",\n")}
            ],
            "dev_files": [
                {"type": "script", "file": "index.js", "sri": "${get_file_hash(`${module_name || package}/index.js`)}", "size": ${sizeDev}, "gzipSize": ${sizeDevGzip}}${dev_style_files.length ? "," : ""}
                ${dev_style_files.map(style => `{"type": "style", "file": "${style.file}", "sri": "${style.sri}", "gzipSize": ${style.sizeGzip}, "size": ${style.size}}`).join(",\n")}
            ]
        }
        `.trim());

        try {
            fs.unlinkSync(path.join(__cwd, "__deps.json"));
        } catch (e) {

        }

        if (has_gen_entry) {
            fs.unlinkSync(path.join(__cwd, `/node_modules/${module_name || package}/index.js`));
        }

        // copy over definition files
        copy_types(path.join(__cwd, "node_modules", module_name || package), [], ".d.ts", true);

        if (types && types.length) {
            copy_types(path.join(__cwd, "node_modules", ...types[0].split("/")), [], ".d.ts", true);
        }

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

        const remove_empty_dirs = (scan_dir, subdirs) => {

            try {
                const files = fs.readdirSync(path.join(scan_dir, ...subdirs));
                if (files.length == 0) {
                    fs.rmdirSync(path.join(scan_dir, ...subdirs));
                } else {
                    for (key in files) {
                        if (fs.fstatSync(fs.openSync(path.join(scan_dir, ...subdirs, files[key]))).isFile() == false) {
                            remove_empty_dirs(scan_dir, [...subdirs, files[key]]);
                        }
                    }
                }

            } catch (e) {

            }
        }

        remove_empty_dirs(path.join(__cwd, "libs", module_name || package), []);



    })()


    console.log("Compilation Finished");
    return;

}

/**
 * Format bytes as human-readable text.
 * 
 * @param bytes Number of bytes.
 * @param si True to use metric (SI) units, aka powers of 1000. False to use 
 *           binary (IEC), aka powers of 1024.
 * @param dp Number of decimal places to display.
 * 
 * @return Formatted string.
 */
 function humanFileSize(bytes, si=false, dp=1) {
    const thresh = si ? 1000 : 1024;
  
    if (Math.abs(bytes) < thresh) {
      return bytes + ' B';
    }
  
    const units = si 
      ? ['kB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'] 
      : ['KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB', 'ZiB', 'YiB'];
    let u = -1;
    const r = 10**dp;
  
    do {
      bytes /= thresh;
      ++u;
    } while (Math.round(Math.abs(bytes) * r) / r >= thresh && u < units.length - 1);
  
  
    return bytes.toFixed(dp) + ' ' + units[u];
  }


  