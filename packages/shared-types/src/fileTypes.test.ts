/// <reference types="bun" />
import { describe, it, expect } from 'bun:test'
import { getFileType, type FileLanguage } from './fileTypes'

describe('getFileType', () => {
  it('recognizes markdown variants', () => {
    for (const name of ['notes.md', 'NOTES.MD', 'a.markdown', 'b.mdown', 'c.mkd']) {
      const info = getFileType(name)
      expect(info.isText).toBe(true)
      expect(info.isMarkdown).toBe(true)
      expect(info.language).toBe('markdown')
    }
  })

  it('treats js/ts/jsx/tsx as one javascript language', () => {
    for (const name of ['a.js', 'a.ts', 'a.jsx', 'a.tsx', 'a.mjs', 'a.cjs', 'a.mts', 'a.cts']) {
      const info = getFileType(name)
      expect(info.isText).toBe(true)
      expect(info.isMarkdown).toBe(false)
      expect(info.language).toBe('javascript')
    }
  })

  it('recognizes data formats', () => {
    expect(getFileType('package.json').language).toBe('json')
    expect(getFileType('config.yaml').language).toBe('yaml')
    expect(getFileType('config.yml').language).toBe('yaml')
    expect(getFileType('Cargo.toml').language).toBe('toml')
  })

  it('recognizes other supported languages', () => {
    const cases: Array<[string, FileLanguage]> = [
      ['index.html', 'html'],
      ['style.css', 'css'],
      ['feed.xml', 'xml'],
      ['main.py', 'python'],
      ['App.java', 'java'],
      ['main.go', 'go'],
      ['lib.rs', 'rust'],
      ['app.c', 'cpp'],
      ['app.cpp', 'cpp'],
      ['app.h', 'cpp'],
      ['query.sql', 'sql'],
      ['index.php', 'php'],
      ['script.sh', 'shell'],
      ['app.rb', 'ruby']
    ]
    for (const [name, lang] of cases) {
      expect(getFileType(name).language).toBe(lang)
    }
  })

  it('treats plain text formats as text without language', () => {
    for (const name of ['notes.txt', 'app.log', '.env', '.gitignore', 'data.csv', 'app.ini', 'app.conf']) {
      const info = getFileType(name)
      expect(info.isText).toBe(true)
      expect(info.isMarkdown).toBe(false)
      expect(info.language).toBe(null)
    }
  })

  it('treats files without extension as plain text', () => {
    for (const name of ['README', 'LICENSE', 'Makefile', 'Dockerfile']) {
      const info = getFileType(name)
      expect(info.isText).toBe(true)
      expect(info.language).toBe(null)
    }
  })

  it('rejects binary files', () => {
    for (const name of ['image.png', 'photo.jpg', 'archive.zip', 'app.dmg', 'doc.pdf', 'video.mp4', 'bin.exe']) {
      const info = getFileType(name)
      expect(info.isText).toBe(false)
      expect(info.isMarkdown).toBe(false)
    }
  })

  it('is case-insensitive on extension', () => {
    expect(getFileType('Main.PY').language).toBe('python')
    expect(getFileType('App.JSON').language).toBe('json')
  })

  it('accepts full paths', () => {
    expect(getFileType('/foo/bar/baz.json').language).toBe('json')
    expect(getFileType('C:\\repo\\file.ts').language).toBe('javascript')
  })
})
