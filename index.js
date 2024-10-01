let { readFileSync } = require('node:fs')
let { basename, extname, join, relative } = require('node:path')
let { parse } = require('postcss-js')
let vars = require('postcss-simple-vars')
let sugarss = require('sugarss')
let { globSync } = require('tinyglobby')

const MAYBE_QUOTED_PATTERN = /^["']?((?<=["']).+(?=["'])|(?:.+))["']?$/
let MIXINS_GLOB = '*.{js,cjs,mjs,json,css,sss,pcss}'

function parseMixin(rule) {
  let { name, paramString } =
    rule.params.match(
      /^(?<name>[a-zA-Z_-]+).?(?<paramString>(?:(?<=\().+(?=\))|(?<=\s).+))?.?$/
    )?.groups ?? []

  if (!name) {
    throw rule.error(`Invalid mixin definition: ${rule.toString()}`)
  }

  paramString = paramString?.trim() ?? ''

  return { name, paramString }
}

const unwrap = str => str.match(MAYBE_QUOTED_PATTERN)?.[1] ?? str

function addMixin(helpers, mixins, rule, file) {
  let { name, paramString } = parseMixin(rule)

  let args = []
  if (paramString.length) {
    args = helpers.list.comma(paramString).map(str => {
      let arg = str.split(':', 1)[0]
      let defaults = str.slice(arg.length + 1).trim()
      arg = arg.slice(1).trim()
      defaults = unwrap(defaults)

      return [arg, defaults]
    })
  }

  let content = false
  rule.walkAtRules('mixin-content', () => {
    content = true
    return false
  })

  mixins[name] = { args, content, mixin: rule }
  if (file) mixins[name].file = file
  rule.remove()
}

function processModulesForHotReloadRecursively(module, helpers) {
  let moduleId = module.id
  module.children.forEach(childModule => {
    helpers.result.messages.push({
      file: childModule.id,
      parent: moduleId,
      type: 'dependency'
    })
    processModulesForHotReloadRecursively(childModule, helpers)
  })
  delete require.cache[moduleId]
}

function loadGlobalMixin(helpers, globs) {
  let cwd = process.cwd()
  let files = globSync(globs, {
    caseSensitiveMatch: false,
    expandDirectories: false,
    ignore: ['**/node_modules/**', '**/.git/**']
  })
  let mixins = {}
  files.forEach(i => {
    let ext = extname(i).toLowerCase()
    let name = basename(i, extname(i))
    let path = join(cwd, relative(cwd, i))
    if (ext === '.css' || ext === '.pcss' || ext === '.sss') {
      let content = readFileSync(path)
      let root
      if (ext === '.sss') {
        root = sugarss.parse(content, { from: path })
      } else {
        root = helpers.parse(content, { from: path })
      }
      root.walkAtRules('mixin', atrule => {
        addMixin(helpers, mixins, atrule, path)
      })
    } else {
      try {
        mixins[name] = { file: path, mixin: require(path) }
        let module = require.cache[require.resolve(path)]
        if (module) {
          processModulesForHotReloadRecursively(module, helpers)
        }
      } catch {}
    }
  })
  return mixins
}

function addGlobalMixins(helpers, local, global, parent) {
  for (let name in global) {
    helpers.result.messages.push({
      file: global[name].file,
      parent: parent || '',
      type: 'dependency'
    })
    local[name] = global[name]
  }
}

function watchNewMixins(helpers, mixinsDirs) {
  let uniqueDirsPath = Array.from(new Set(mixinsDirs))
  for (let dir of uniqueDirsPath) {
    helpers.result.messages.push({
      dir,
      glob: MIXINS_GLOB,
      parent: '',
      type: 'dir-dependency'
    })
  }
}

function processMixinContent(rule, from) {
  rule.walkAtRules('mixin-content', content => {
    if (from.nodes && from.nodes.length > 0) {
      content.replaceWith(from.clone().nodes)
    } else {
      content.remove()
    }
  })
}

function insertObject(rule, obj, singeArgumentsMap) {
  let root = parse(obj)
  root.each(node => {
    node.source = rule.source
  })
  processMixinContent(root, rule)
  unwrapSingleArguments(root.nodes, singeArgumentsMap)
  rule.parent.insertBefore(rule, root)
}

function unwrapSingleArguments(rules, singleArgumentsMap) {
  if (singleArgumentsMap.size <= 0) {
    return
  }

  for (let rule of rules) {
    if (rule.type === 'decl') {
      if (rule.value.includes('single-arg')) {
        let newValue = rule.value
        for (let [key, value] of singleArgumentsMap) {
          newValue = newValue.replace(key, value)
        }
        rule.value = newValue
      }
    } else if (rule.type === 'rule') {
      unwrapSingleArguments(rule.nodes, singleArgumentsMap)
    }
  }
}

function resolveSingleArgumentValue(value, parentNode) {
  let content = value.slice('single-arg'.length).trim()

  if (!content.startsWith('(') || !content.endsWith(')')) {
    throw parentNode.error(
      'Content of single-arg must be wrapped in brackets: ' + value
    )
  }

  return content.slice(1, -1)
}

function insertMixin(helpers, mixins, rule, opts) {
  let { name, paramString } = parseMixin(rule)

  let params
  if (paramString.trim() === '') {
    params = []
  } else {
    params = helpers.list.comma(paramString).map(unwrap)
  }

  let meta = mixins[name]
  let mixin = meta && meta.mixin
  let singleArgumentsMap = new Map(
    params
      .filter(param => param.startsWith('single-arg'))
      .map(param => [param, resolveSingleArgumentValue(param, rule)])
  )

  if (!meta) {
    if (!opts.silent) {
      throw rule.error('Undefined mixin ' + name)
    }
  } else if (mixin.name === 'mixin') {
    let i
    let values = {}
    for (i = 0; i < meta.args.length; i++) {
      values[meta.args[i][0]] = params[i] || meta.args[i][1]
    }

    let proxy = new helpers.Root()
    for (i = 0; i < mixin.nodes.length; i++) {
      let node = mixin.nodes[i].clone()
      delete node.raws.before
      proxy.append(node)
    }

    if (meta.args.length) {
      proxy = helpers.postcss([vars({ only: values })]).process(proxy).root
    }

    if (meta.content) processMixinContent(proxy, rule)

    unwrapSingleArguments(proxy.nodes, singleArgumentsMap)

    rule.parent.insertBefore(rule, proxy)
  } else if (typeof mixin === 'object') {
    insertObject(rule, mixin, singleArgumentsMap)
  } else if (typeof mixin === 'function') {
    let args = [rule].concat(params)
    rule.walkAtRules(atRule => {
      if (atRule.name === 'include' || atRule.name === 'add-mixin') {
        insertMixin(helpers, mixins, atRule, opts)
      }
    })
    let nodes = mixin(...args)
    if (typeof nodes === 'object') {
      insertObject(rule, nodes, singleArgumentsMap)
    }
  } else {
    throw new Error('Wrong ' + name + ' mixin type ' + typeof mixin)
  }

  if (rule.parent) rule.remove()
}

module.exports = (opts = {}) => {
  let loadFrom = []
  if (opts.mixinsDir) {
    if (!Array.isArray(opts.mixinsDir)) {
      opts.mixinsDir = [opts.mixinsDir]
    }
    loadFrom = opts.mixinsDir.map(dir => join(dir, MIXINS_GLOB))
  }
  if (opts.mixinsFiles) loadFrom = loadFrom.concat(opts.mixinsFiles)
  loadFrom = loadFrom.map(path => path.replace(/\\/g, '/'))

  return {
    postcssPlugin: 'postcss-mixins',

    prepare() {
      let mixins = {}

      if (typeof opts.mixins === 'object') {
        for (let i in opts.mixins) {
          mixins[i] = { mixin: opts.mixins[i] }
        }
      }

      return {
        AtRule: {
          'add-mixin': (node, helpers) => {
            insertMixin(helpers, mixins, node, opts)
          },
          'include': (node, helpers) => {
            insertMixin(helpers, mixins, node, opts)
          },
          'mixin': (node, helpers) => {
            addMixin(helpers, mixins, node)
            node.remove()
          }
        },
        Once(root, helpers) {
          if (loadFrom.length > 0) {
            try {
              let global = loadGlobalMixin(helpers, loadFrom)
              addGlobalMixins(helpers, mixins, global, opts.parent)
            } catch {}
          }
        },
        OnceExit(_, helpers) {
          if (opts.mixinsDir && opts.mixinsDir.length > 0) {
            watchNewMixins(helpers, opts.mixinsDir)
          }
        }
      }
    }
  }
}
module.exports.postcss = true
