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

    const write_html = (() => {
        for (let i in process.argv) {
            if (process.argv[i].indexOf("html=") !== -1) {
                return process.argv[i].split("=").pop();
            }
        }
        return "";
    })();

    const handle_library_file = (folder_name) => {
        let file_size = 0;
        let sri = "";
        let location = "";
        const libJSON = JSON.parse(fs.readFileSync(path.join(__cwd, "libs", folder_name, "amd_lib.json")).toString());
        (type == "dev" ? libJSON.devFiles : libJSON.files).forEach((jsFile) => {
            if (jsFile.file.indexOf("index") !== -1 && jsFile.file.indexOf(".js") !== -1) {
                file_size += jsFile.sizeKB;
                sri = jsFile.sri;
                location = `"${folder_name}": "libs/${folder_name}/${jsFile.file}",\n`;
            }
        });
        return [file_size, sri, location];
    };

    const handle_js_file = (root_dir, subdirs, file) => {
        let file_size = fs.readFileSync(path.join(root_dir, ...subdirs, file)).toString().length / 1000;
        let sri = get_file_hash(path.join("..", ...subdirs, file));
        return [file_size, sri, path.join(...subdirs, file.replace('.js', ''))];
    };

    let new_pack_file = `
(function() {
    var __counter = 0;
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

        if (require) {
            clearInterval(__require);
            _amd_packer_config();
        }
    }, 16);

    function _amd_packer_config() {
        requirejs.config({
            deps: ['app'],
            paths: {
`;

    let hashes = {};
    let sizes = 0;



    // load libs
    const scan_libs = (root_dir, other_dirs) => {
        let files = fs.readdirSync(path.join(root_dir, ...other_dirs));
        for (let i in files) {
            const file = files[i];
            const isDir = fs.fstatSync(fs.openSync(path.join(root_dir, ...other_dirs, file))).isDirectory();
            if (isDir) {
                scan_libs(root_dir, [...other_dirs, file]);
            } else if (file == "amd_lib.json") {
                const [file_size, sri, location] = handle_library_file(path.join(...other_dirs));
                sizes += file_size;
                hashes[path.join(...other_dirs)] = sri;
                new_pack_file += location.replace(".js", "");
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
                } else if (file.indexOf(".js") !== -1) {
                    const [file_size, sri, location] = handle_js_file(root_dir, other_dirs, file);
                    sizes += file_size;
                    hashes[location] = sri;
                }
            }
        } catch (e) {

        }
    };
    scan_files(__cwd, ["pages"]);
    scan_files(__cwd, ["components"]);

    // load app.js
    let files = fs.readdirSync(__cwd);

    const app_file = type == "dev" ? "app.js" : "app.min.js";
    let found_app = false;
    for (let i in files) {
        if (app_file == files[i]) {
            found_app = true;
            const sri = get_file_hash(path.join("..", app_file));
            if (type == "prod") {
                hashes["app"] =  sri;
            }
            new_pack_file += `"app": "./${app_file.replace(".js", "")}"`;
            sizes += fs.readFileSync(path.join(__cwd, app_file)).toString().length / 1000;
        }
    }

    if (found_app == false) {
        console.error(`Unable to find ${app_file} in root!`);
        process.exit();
    }

    new_pack_file += `
            },
            onNodeCreated: function(node, config, module, path) {
                var sri = sri_obj[module];

                if (sri) {
                    node.setAttribute('integrity', sri);
                    node.setAttribute('crossorigin', 'anonymous');
                } else {
                    ${type == "prod" ? `console.log("Security error, no integrity found for module:", module)` : ''};
                }

            }
        });
    }

    var sri_obj = ${type == "prod" ? JSON.stringify(hashes, null, 4) : "{}"};
})();`;

    fs.writeFileSync(path.join(__cwd, "libs", "pack.js"), new_pack_file.trim());

    if (type == "dev") {
        if (!fs.existsSync(path.join(__cwd, "libs", "require.js"))) {
            request('https://requirejs.org/docs/release/2.3.6/comments/require.js').pipe(fs.createWriteStream(path.join(__cwd, "libs", "require.js")));
        }
    
    } else {

        child.execSync(`./node_modules/.bin/minify ${path.join(__cwd, "libs", "pack.js")} > ${path.join(__cwd, "libs", "pack.min.js")}`, {cwd: __dirname});
        //fs.unlinkSync(path.join(__cwd, "libs", "pack.js"));

        if (!fs.existsSync(path.join(__cwd, "libs", "require.min.js"))) {
            request('https://requirejs.org/docs/release/2.3.6/minified/require.js').pipe(fs.createWriteStream(path.join(__cwd, "libs", "require.min.js")));
        }
    
    }

    const shasum = get_file_hash(type == "dev" ? "pack.js" : "pack.min.js");
    const shasumRequire = get_file_hash(type == "dev" ? "require.js" : "require.min.js");


    console.log("Completed!");
    console.log(`Total application and library size: ${Math.round(sizes * 10) / 10}kb`);
    console.log("");

    let finished = `<script async integrity="${shasumRequire}" crossorigin="anonymous" src="libs/require${type == "prod" ? ".min" : ""}.js"></script>\n`;
    finished += `<script async integrity="${shasum}" crossorigin="anonymous" src="libs/pack${type == "prod" ? ".min" : ""}.js"></script>\n`;
    
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
            const file_contents = fs.readFileSync(path.join(__cwd, "node_modules", package, file_name)).toString();

            fs.copyFileSync(path.join(__cwd, "node_modules", package, file_name), path.join(__cwd, "libs", module_name || package, file_name.split(path.sep).pop()));
            style_files.push({size: file_contents.length / 1000, file: file_name.split(path.sep).pop(), sri: get_file_hash(path.join(__dirname, module_name || package, file_name))});
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
                {"type": "prodjs", "file": "${prodFileName}", "sri": "${get_file_hash(`${module_name || package}/${prodFileName}`)}", "sizeKB": ${sizeProd / 1000}},
                {"type": "devjs", "file": "index.js", "sri": "${get_file_hash(`${module_name || package}/index.js`)}", "sizeKB": ${sizeDev / 1000}},
                ${style_files.map(style => `{"type": "style", "file": "${module_name || package}/${style.file}", "sri": "${style.sri}", "sizeKB": ${style.size}}`).join(",\n")}
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