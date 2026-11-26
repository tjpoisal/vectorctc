#!/usr/bin/env node
/* global console */
// Builds data/osv-seed.json: real OSV advisories for a fixed list of popular packages, so the SCA check
// works offline out of the box. Run with network; the gate never fetches. `ctc advisories sync` refreshes
// a project-specific cache with every dependency in its lockfiles.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchOsv } from "../dist/security/advisories.js";

const npm = ["lodash", "minimist", "axios", "express", "jsonwebtoken", "moment", "node-fetch", "ws", "qs", "semver", "tar", "follow-redirects", "undici", "next", "vite", "webpack", "postcss", "ejs", "handlebars", "marked", "xml2js", "shell-quote", "json5", "tough-cookie", "body-parser", "cookie", "path-to-regexp", "send", "serve-static", "socket.io-parser", "ua-parser-js", "underscore", "async", "debug", "glob-parent", "nth-check", "trim-newlines", "decode-uri-component", "word-wrap", "braces", "micromatch", "ip", "jose", "crypto-js", "dompurify", "sanitize-html", "validator", "mongoose", "sequelize", "pg", "mysql2", "knex", "request", "uuid"];
const pypi = ["django", "flask", "requests", "urllib3", "jinja2", "pyyaml", "pillow", "cryptography", "werkzeug", "sqlalchemy", "numpy", "aiohttp", "fastapi", "starlette", "paramiko", "lxml", "certifi", "setuptools", "tornado", "gunicorn"];
const go = ["golang.org/x/crypto", "golang.org/x/net", "golang.org/x/text", "github.com/gin-gonic/gin", "github.com/gorilla/websocket", "github.com/dgrijalva/jwt-go", "github.com/golang-jwt/jwt", "gopkg.in/yaml.v2", "github.com/labstack/echo/v4", "google.golang.org/grpc", "github.com/gofiber/fiber/v2", "google.golang.org/protobuf"];
const db = await fetchOsv([...npm.map((name) => ({ ecosystem: "npm", name })), ...pypi.map((name) => ({ ecosystem: "PyPI", name })), ...go.map((name) => ({ ecosystem: "Go", name }))]);
db.source = "OSV (api.osv.dev) seed: popular npm, PyPI and Go packages";
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "osv-seed.json");
fs.writeFileSync(out, JSON.stringify(db) + "\n");
const count = Object.values(db.packages).reduce((s, l) => s + l.length, 0);
console.log(`wrote ${out}: ${count} advisories, ${Object.keys(db.packages).length} packages, ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
