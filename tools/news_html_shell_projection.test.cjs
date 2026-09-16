"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const previousDataDirectory = process.env.DATA_DIR
const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "news-html-shell-"))
process.env.DATA_DIR = databaseDirectory

const { toClientNews, toClientNewsHtml } = require("../src/lib/news-catalog")

test.after(() => {
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})

test("empty body projects to an empty html shell", () => {
    assert.equal(toClientNewsHtml(""), "<html><body></body></html>")
    assert.equal(toClientNewsHtml("   \r\n"), "<html><body></body></html>")
})

test("a single-root fragment is wrapped into a full html document", () => {
    assert.equal(
        toClientNewsHtml("<p>higher same second</p>"),
        "<html><body><p>higher same second</p></body></html>",
    )
})

test("a multi-root fragment is wrapped so the client Xml.parse stays single-rooted", () => {
    // CN client RichTextLayoutParser uses flash.Xml.parse (strict XML, single root);
    // storage validateNewsRichText accepts multi-root fragments like this one.
    assert.equal(
        toClientNewsHtml("<h1>one</h1><h2>two</h2><h3>three</h3>"),
        "<html><body><h1>one</h1><h2>two</h2><h3>three</h3></body></html>",
    )
})

test("an already complete html document is not double-wrapped", () => {
    const document = "<!DOCTYPE html/>\r\n<html lang=\"en\"><head><title>news</title></head><body class=\"body\"><p>x</p></body></html>"
    assert.equal(toClientNewsHtml(document), document)
})

test("a body-only document passes through untouched", () => {
    const bodyOnly = "<body><p>x</p></body>"
    assert.equal(toClientNewsHtml(bodyOnly), bodyOnly)
})

test("toClientNews projects the html shell for the client", () => {
    const projected = toClientNews({
        id: 7,
        title: "t",
        publishedAtReal: "2026-08-30T08:00:00.000Z",
        bodyRichText: "<p>a</p><p>b</p>",
        label: 4,
        thumbnail: 7,
    })
    assert.equal(projected.html, "<html><body><p>a</p><p>b</p></body></html>")
})
