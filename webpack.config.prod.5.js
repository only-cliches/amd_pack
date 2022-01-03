const path = require("path");
const fs = require("fs");
const child = require("child_process");
const webpack = require('webpack');

// npm view carbon-components version
// shasum -b -a 512 libs/carbon-components/index.min.js | awk '{ print $1 }' | xxd -r -p | base64

const production = process.argv[process.argv.length - 2].split("=").pop() == "prod" ? true : false;

const module_name = process.argv[process.argv.length - 1].split("=").pop();

const project_cwd = Buffer.from(process.argv[process.argv.length - 3].split("::").pop(), 'base64').toString('ascii');

const local_modules = Buffer.from(process.argv[process.argv.length - 4].split("::").pop(), 'base64').toString('ascii').trim();

const index_file = Buffer.from(process.argv[process.argv.length - 5].split("::").pop(), 'base64').toString('ascii').trim();

const set_module_name = Buffer.from(process.argv[process.argv.length - 6].split("::").pop(), 'base64').toString('ascii').trim();

if (production) {
    console.log("Production Build:");
} else {
    console.log("Development Build:");
}

const package_file = JSON.parse(fs.readFileSync(path.join(project_cwd, `/node_modules/${module_name}/package.json`)).toString());

const new_package = String(module_name);

let dependecy_count = 0;

module.exports = {
    mode: production ? "production" : "development",
    entry: path.join(project_cwd, `/node_modules/${module_name}/${index_file || package_file.main || "index.js"}`),
    output: {
        library: set_module_name || new_package,
        libraryTarget: 'amd',
        path: path.resolve(project_cwd, 'libs', set_module_name || new_package),
        filename: `index${production ? ".min": ""}.js`
    },
    devtool: false,
    node: false,
    optimization: {
        minimize: production
    },
    externals: [
        function({ context, request }, callback) {

            dependecy_count += 1;

            const paths = ["../", "./"].map(p => request.indexOf(p));

            const depdency = JSON.parse((() => {
                try {
                    return fs.readFileSync(path.join(project_cwd, "__deps.json"));
                } catch (e) {
                    return "{}";
                }
            })());

            const is_remote_dependency = () => {

                if (request.indexOf("!!webpack") !== -1) {
                    return false;
                }
                
                const first_char = Array.from(request)[0];
                // const num_slahes = Array.from(request).filter(f => f == "/").length;
                if (first_char == "/" || first_char == ".") {
                    return false;
                }
                return true;
            };

            const request_package = (() => {
                if (request.indexOf("@") !== -1) {
                    return request.split(/\//gmi).filter((o, i) => i < 2).join("/");
                }
                return request.split(/\//gmi).filter((o, i) => i < 1).join("/");
            })();

            const request_root = (() => {
                const root_module = (() => {
                    if (module_name.indexOf("@") !== -1) {
                        return module_name.split(/\//gmi).filter((o, i) => i < 2).join("/");
                    }
                    return module_name.split(/\//gmi).filter((o, i) => i < 1).join("/");
                })();
                const package_loc = context.indexOf(root_module);
                if (package_loc == -1) {
                    return false;
                } else {
                    return context.slice(package_loc).replace(local_modules, "");
                }
            })();


            if (is_remote_dependency() == false && dependecy_count > 1 && local_modules.length) {
                return callback(null, 'amd ' + path.join(request_root, request.replace(/\.\w+$/gmi, "")));
            }

            if (is_remote_dependency()) {
                if (!depdency[request_package]) {
                    try {
                        child.execSync(`npm install ${request_package}`, {cwd: project_cwd});
                    } catch (e) { }

                    try {
                        const version = package_file.dependencies[request_package];
                        depdency[request_package] = version;
                        fs.writeFileSync(path.join(project_cwd, "__deps.json"), JSON.stringify(depdency, null, 4));
                    } catch (e) {
   
                        
                        const package = JSON.parse(fs.readFileSync(path.join(project_cwd, "node_modules", request_package, "package.json")));
                        const version = package.version;    
                        depdency[request_package] = version;
                        fs.writeFileSync(path.join(project_cwd, "__deps.json"), JSON.stringify(depdency, null, 4));
                    }

                }

                const adjusted_request = request.replace("@babel/runtime/helpers/esm/", "@babel/runtime/helpers/");

                return callback(null, 'amd ' + adjusted_request);
            }

            // Continue without externalizing the import
            callback();
        },
    ],
    module: {
        rules: [
            {
                test: /\.js$/,
                use: {
                    loader: 'babel-loader',
                    options: {
                        presets: ['@babel/preset-env'],
                        plugins: ["@babel/plugin-proposal-class-properties"]
                    }
                }
            },
            {
                test: /\.css$/,
                use: ["style-loader", "css-loader"]
            },
            { 
                test: /\.tsx?$/, 
                loader: "ts-loader"
            }
        ]
    },
    plugins: [
        new webpack.EnvironmentPlugin({
            NODE_ENV: production ? 'production' : 'development',
            DEBUG: false
        }),
        new webpack.optimize.LimitChunkCountPlugin({
            maxChunks: 1,
        }),
    ]
};