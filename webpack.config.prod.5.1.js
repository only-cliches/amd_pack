const path = require("path");
const fs = require("fs");
const child = require("child_process");
const webpack = require('webpack');
const nodeExternals = require('webpack-node-externals');

// npm view carbon-components version
// shasum -b -a 512 libs/carbon-components/index.min.js | awk '{ print $1 }' | xxd -r -p | base64

const json_string = (() => {
    for (let i in process.argv) {
        if (process.argv[i].indexOf("config::") !== -1) {
            return process.argv[i].slice(8);
        }
    }
    return "";
})();
const json_data = JSON.parse(Buffer.from(json_string, 'base64').toString('utf-8'));

module.exports = {
    mode: json_data.mode == "prod" ? "production" : "development",
    entry: json_data.entry,
    output: {
        library: json_data.library,
        libraryTarget: 'amd',
        path: json_data.path,
        filename: json_data.filename
    },
    devtool: false,
    node: false,
    optimization: {
        minimize: json_data.mode == "prod"
    },
    externalsPresets: { node: true },
    externals: [nodeExternals()],
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
            NODE_ENV: json_data.mode == "prod" ? 'production' : 'development',
            DEBUG: false
        }),
        new webpack.optimize.LimitChunkCountPlugin({
            maxChunks: 1,
        }),
    ]
};