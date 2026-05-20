const path = require('path');
const webpack = require('webpack');
const { EsbuildPlugin } = require('esbuild-loader');
const VueLoaderPlugin = require('vue-loader/lib/plugin');
const ForkTsCheckerWebpackPlugin = require('fork-ts-checker-webpack-plugin');
const NodePolyfillPlugin = require('node-polyfill-webpack-plugin');

const config = {
  entry: {
    chat: [path.join(__dirname, 'chat.ts'), path.join(__dirname, 'index.html')],
  },
  output: {
    path: path.join(__dirname, 'www'),
    publicPath: './',
    filename: '[name].js',
  },
  context: __dirname,
  target: 'web',
  module: {
    rules: [
      {
        test: /\.vue$/,
        loader: 'vue-loader',
        options: {
          compilerOptions: {
            preserveWhitespace: false,
          },
        },
      },
      {
        test: /\.ts$/,
        loader: 'esbuild-loader',
        options: {
          loader: 'ts',
          target: 'es2017',
          tsconfig: path.join(__dirname, 'tsconfig.json'),
        },
      },
      { test: /\.eot(\?v=\d+\.\d+\.\d+)?$/, loader: 'file-loader' },
      { test: /\.(woff2?)$/, loader: 'file-loader' },
      { test: /\.ttf(\?v=\d+\.\d+\.\d+)?$/, loader: 'file-loader' },
      { test: /\.svg(\?v=\d+\.\d+\.\d+)?$/, loader: 'file-loader' },
      {
        test: /\.(wav|mp3|ogg)$/,
        loader: 'file-loader',
        options: { name: 'sounds/[name].[ext]' },
      },
      {
        test: /\.(png|html)$/,
        loader: 'file-loader',
        options: { name: '[name].[ext]' },
      },
      {
        test: /\.vue\.scss/,
        use: [
          'vue-style-loader',
          { loader: 'css-loader', options: { esModule: false } },
          {
            loader: 'sass-loader',
            options: {
              warnRuleAsWarning: false,
              sassOptions: {
                quietDeps: true,
                silenceDeprecations: [
                  'import',
                  'color-functions',
                  'global-builtin',
                  'slash-div',
                  'function-units',
                  'if-function',
                ],
              },
            },
          },
        ],
      },
      {
        test: /\.vue\.css/,
        use: [
          'vue-style-loader',
          { loader: 'css-loader', options: { esModule: false } },
        ],
      },
      {
        // Non-Vue SCSS: used via require() in scripts to get CSS string (e.g. theme injection)
        test: /\.scss$/,
        exclude: /\.vue$/,
        use: [
          { loader: 'css-loader', options: { esModule: false } },
          {
            loader: 'sass-loader',
            options: {
              warnRuleAsWarning: false,
              sassOptions: {
                quietDeps: true,
                silenceDeprecations: [
                  'import',
                  'color-functions',
                  'global-builtin',
                  'slash-div',
                  'function-units',
                  'if-function',
                ],
              },
            },
          },
        ],
      },
    ],
  },
  plugins: [
    new ForkTsCheckerWebpackPlugin({
      typescript: {
        configFile: path.join(__dirname, 'tsconfig.json'),
      },
    }),
    new VueLoaderPlugin(),
    new NodePolyfillPlugin({ additionalAliases: ['process'] }),
    // Ensure process.versions.node is defined so packages like adm-zip don't crash
    new webpack.DefinePlugin({
      'process.versions': JSON.stringify({ node: '22.0.0' }),
      'process.version': JSON.stringify('v22.0.0'),
    }),
  ],
  resolve: {
    alias: {
      electron: path.join(__dirname, 'shims/electron.js'),
      'electron-log': path.join(__dirname, 'shims/electron-log.js'),
      '@electron/remote': path.join(__dirname, 'shims/electron-remote.js'),
      archiver: path.join(__dirname, 'shims/archiver.js'),
      [path.resolve(__dirname, '../electron/filesystem')]: path.join(__dirname, 'shims/electron-filesystem.js'),
      [path.resolve(__dirname, '../learn/store/worker')]: path.join(__dirname, 'shims/worker-store.js'),
    },
    fallback: {
      fs: path.join(__dirname, 'shims/fs.js'),
      tls: false,
      net: false,
    },
    extensions: ['.ts', '.js', '.vue', '.scss'],
  },
  experiments: { cacheUnaffected: true },
};

module.exports = function (mode) {
  const cacheConfig = {
    type: 'filesystem',
    name: `mobile-${mode}`,
    buildDependencies: {
      config: [
        __filename,
        path.resolve(__dirname, '..', 'pnpm-lock.yaml'),
        path.resolve(__dirname, '..', 'tsconfig.json'),
        path.join(__dirname, 'tsconfig.json'),
      ],
    },
  };

  if (mode === 'production') {
    process.env.NODE_ENV = 'production';
    config.devtool = false;
    config.output.pathinfo = false;
    config.optimization = {
      minimizer: [new EsbuildPlugin({ target: 'es2017' })],
    };
  } else {
    config.devtool = 'eval-source-map';
    config.output.pathinfo = false;
  }

  config.cache = cacheConfig;
  return config;
};
