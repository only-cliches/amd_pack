const path = require("path");
const fs = require("fs");
const child = require("child_process");
const webpack = require('webpack');

// npm view carbon-components version
// shasum -b -a 512 libs/carbon-components/index.min.js | awk '{ print $1 }' | xxd -r -p | base64

const production = process.argv[process.argv.length - 2].split("=").pop() == "prod" ? true : false;

const module_name = process.argv[process.argv.length - 1].split("=").pop();

const project_cwd = Buffer.from(process.argv[process.argv.length - 3].split("=").pop(), 'base64').toString('ascii');

if (production) {
    console.log("Production Build:");
} else {
    console.log("Development Build:");
}

const package_file = JSON.parse(fs.readFileSync(path.join(project_cwd, `/node_modules/${module_name}/package.json`)).toString());

const new_package = String(module_name);

module.exports = {
    mode: production ? "production" : "development",
    entry: path.join(project_cwd, `/node_modules/${module_name}/${package_file.main || "index.js"}`),
    output: {
        library: new_package,
        libraryTarget: 'amd',
        path: path.resolve(project_cwd, 'libs', new_package),
        filename: `index${production ? ".min": ""}.js`
    },
    devtool: false,
    node: false,
    optimization: {
        minimize: production
    },
    externals: [
        function({ context, request }, callback) {

            const paths = ["../", "./"].map(p => request.indexOf(p));

            const depdency = JSON.parse((() => {
                try {
                    return fs.readFileSync("deps.json");
                } catch (e) {
                    return "{}";
                }
            })());

            const is_remote_dependency = () => {

                if (request.indexOf("!!webpack") !== -1) {
                    return false;
                }
                
                const first_char = Array.from(request)[0];
                const num_slahes = Array.from(request).filter(f => f == "/").length;

                if (first_char == "/" || first_char == ".") {
                    return false;
                } else if (first_char == "@") {
                    return num_slahes <= 1;
                } else {
                    return num_slahes == 0;
                }
            };

            if (is_remote_dependency()) {
            

                if (!depdency[request]) {
                    try {
                        const version = package_file.dependencies[request];
                        depdency[request] = version;
                        fs.writeFileSync("deps.json", JSON.stringify(depdency, null, 4));
                    } catch (e) {
                        try {
                            child.execSync(`npm install ${request}`);
                        } catch (e) { }
                        
                        const package = JSON.parse(fs.readFileSync(path.join(project_cwd, "node_modules", request, "package.json")));
                        const version = package.version;    
                        depdency[request] = version;
                        fs.writeFileSync("deps.json", JSON.stringify(depdency, null, 4));

                        try {
                            child.execSync(`npm uninstall ${request}`);
                        } catch (e) { }
                    }

                }

                return callback(null, 'amd ' + request);
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