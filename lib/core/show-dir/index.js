'use strict';

const styles = require('./styles');
const permsToString = require('./perms-to-string');
const sizeToString = require('./size-to-string');
const sortFiles = require('./sort-files');
const fs = require('fs');
const path = require('path');
const he = require('he');
const etag = require('../etag');
const url = require('url');
const status = require('../status-handlers');

const supportedIcons = styles.icons;
const css = styles.css;

module.exports = (opts) => {
  // opts are parsed by opts.js, defaults already applied
  const cache = opts.cache;
  const root = path.resolve(opts.root);
  const baseDir = opts.baseDir;
  const humanReadable = opts.humanReadable;
  const hidePermissions = opts.hidePermissions;
  const handleError = opts.handleError;
  const showDotfiles = opts.showDotfiles;
  const si = opts.si;
  const weakEtags = opts.weakEtags;

  return function middleware(req, res, next) {
    // Figure out the path for the file from the given url
    const parsed = url.parse(req.url);
    const pathname = decodeURIComponent(parsed.pathname);
    const dir = path.normalize(
      path.join(
        root,
        path.relative(
          path.join('/', baseDir),
          pathname
        )
      )
    );

    fs.stat(dir, (statErr, stat) => {
      if (statErr) {
        if (handleError) {
          status[500](res, next, { error: statErr });
        } else {
          next();
        }
        return;
      }

      // files are the listing of dir
      fs.readdir(dir, (readErr, _files) => {
        let files = _files;

        if (readErr) {
          if (handleError) {
            status[500](res, next, { error: readErr });
          } else {
            next();
          }
          return;
        }

        // Optionally exclude dotfiles from directory listing.
        if (!showDotfiles) {
          files = files.filter(filename => filename.slice(0, 1) !== '.');
        }

        res.setHeader('content-type', 'text/html');
        res.setHeader('etag', etag(stat, weakEtags));
        res.setHeader('last-modified', (new Date(stat.mtime)).toUTCString());
        res.setHeader('cache-control', cache);

        function render(dirs, renderFiles, lolwuts, parent) {
          // each entry in the array is a [name, stat] tuple

          let html = `${[
            '<!DOCTYPE html>',
            '<html lang="en">',
            '  <head>',
            '    <meta charset="utf-8">',
            '    <meta name="robots" content="noindex, nofollow">',
            '    <meta name="viewport" content="width=device-width">',
            '    <link rel="stylesheet" href="/.theme/css/bootstrap.css">',
            '    <link rel="stylesheet" href="/.theme/css/main.css">',
            `    <title>Index of ${he.encode(pathname)}</title>`,
            `    <style type="text/css">${css}</style>`,
            '  </head>',
            '  <body>',
            '<div class="container">',
            `<h1>Index of ${he.encode(pathname)}</h1><hr>`,
          ].join('\n')}\n`;

          html += '<table>';

          const failed = false;

          const convertDateTime = (dt) => {
            let datetime;
            let _;
            try {
              [datetime, _] = dt.toISOString().split('.');
            } catch (err) {
              let nbsps = '&nbsp;'.repeat(9);
              return `${nbsps}-${nbsps}`;
            }
            return datetime.replace('T', ' ');
          };
          const writeRow = (file) => {
            // render a row given a [name, stat] tuple
            const isDir = file[1].isDirectory && file[1].isDirectory();
            const lastModified = convertDateTime(file[1].mtime);
            let href = `${parsed.pathname.replace(/\/$/, '')}/${encodeURIComponent(file[0])}`;

            // append trailing slash and query for dir entry
            if (isDir) {
              href += `/${he.encode((parsed.search) ? parsed.search : '')}`;
            }

            let external = false;
            if (!isDir && file[0].endsWith('.url')) {
              href = fs.readFileSync(path.resolve(parent, file[0]), 'utf-8').trim();
              file[0] = file[0].substring(0, file[0].length - 4);
              external = true;
            }

            const displayName = he.encode(file[0]) + ((isDir) ? '/' : '');
            const ext = file[0].split('.').pop();
            const classForNonDir = supportedIcons[ext] ? ext : '_page';
            const iconClass = `icon-${isDir ? 'folder' : classForNonDir}`;
            const filesize = (external ? '-' : sizeToString(file[1], humanReadable, si)).replace('??k', '0B'); // ??k is for broken symlinks

            // TODO: use stylessheets?
            html += `${'<tr>' +
              '<td><i class="icon '}${iconClass}"></i></td>`;
            if (external) {
              html += `<td class="display-name external"><a href="${href}" target="_blank">${displayName}</a></td>`;
            }
            else {
              html += `<td class="display-name"><a href="${href}">${displayName}</a></td>`;
            }
            html += `<td class="modified"><code>${lastModified}</code></td>`;
            html +=
              `<td class="filesize"><code>${filesize}</code></td>` +
              '</tr>\n';
          };

          dirs.sort((a, b) => a[0].toString().localeCompare(b[0].toString())).forEach(writeRow);
          renderFiles.sort((a, b) => a.toString().localeCompare(b.toString())).forEach(writeRow);
          lolwuts.sort((a, b) => a[0].toString().localeCompare(b[0].toString())).forEach(writeRow);

          html += '</table>\n';
          html += '</div>\n';
          /*
          html += `<script src="/.theme/js/jquery.js"></script>` +
                  `<script src="/.theme/js/bootstrap.js"></script>`+
                  `<script src="/.theme/js/main.js"></script>`; */
          if (req.headers.host.endsWith('you.rocks')) {
            html += '<br><address> Server deployed with <span class="eceheart">&hearts;</span> for YOU\'21 at' +
              ` ${he.encode(req.headers.host || '')}</address>\n` +
              '</body></html>\n'
              ;
          }
          else {
            html += `<br><address>Node.js server ` +
              `running @ ${he.encode(req.headers.host || '')}</address>\n` +
              '</body></html>\n'
              ;
          }

          if (!failed) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(html);
          }
        }

        sortFiles(dir, files, (lolwuts, dirs, sortedFiles) => {
          // It's possible to get stat errors for all sorts of reasons here.
          // Unfortunately, our two choices are to either bail completely,
          // or just truck along as though everything's cool. In this case,
          // I decided to just tack them on as "??!?" items along with dirs
          // and files.
          //
          // Whatever.

          // if it makes sense to, add a .. link
          if (path.resolve(dir, '..').slice(0, root.length) === root) {
            fs.stat(path.join(dir, '..'), (err, s) => {
              if (err) {
                if (handleError) {
                  status[500](res, next, { error: err });
                } else {
                  next();
                }
                return;
              }
              dirs.unshift(['..', s]);
              render(dirs, sortedFiles, lolwuts, dir);
            });
          } else {
            render(dirs, sortedFiles, lolwuts, dir);
          }
        });
      });
    });
  };
};
