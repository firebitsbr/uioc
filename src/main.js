/**
 * Created by exodia on 14-4-14.
 */

void function (define, global, undefined) {
    define(
        function (require) {
            var Container = require('./Container');
            var u = require('./util');
            var Parser = require('./DependencyParser');
            var globalLoader = global.require;
            var ANONY_PREFIX = '^uioc-';

            var creatorWrapper = function (creator, args) {
                return creator.apply(this, args);
            };

            function Context(config) {
                config = config || {};
                if (!(this instanceof Context)) {
                    return new Context(config);
                }

                this.moduleLoader = config.loader || globalLoader;
                this.parser = new (config.parser || Parser)(this);
                this.components = {};
                this.container = new Container(this);
                this.addComponent(config.components || {});
            }

            /**
             * 向容器中注册构件，配置中，args 和 properties 中的每个元素，可以使用 $ref 操作符：
             *      {
             *        args: [ { $ref: 'otherComponent' } ]
             *     }
             *
             * 容器会解析第一层的$ref，从值中获取对应的实例，若实例未注册，返回 null
             *
             * @param {String | Object} id
             * @param {Object} [config]
             * @param {Function | String} config.creator 创建构件的函数或模块名称
             * @param {Boolean=false} config.isFactory 是否为工厂函数，默认false，会通过 new 方式调用，true 时直接调用
             * @param {'transient' | 'singleton' | 'static'} [config.scope = 'transient']
             * 构件作用域，默认为 transient，每次获取构件，都会新建一个实例返回，若为 singleton，则会返回同一个实例
             * 若为 static，则直接返回creator
             *
             * @param {Array} config.args 传递给创建构件函数的参数
             * @param {Object} config.properties 附加给实例的属性
             *      ioc.addComponent('List', {
             *          // 构造函数创建构件 new creator, 或者字符串，字符串则为 amd 模块名
             *          creator: require('./List'),
             *          scope: 'transient',
             *          args: [
             *              {
             *                   $ref: 'entityName'
             *              }
             *          ],
             *
             *          // 属性注入， 不设置$setter, 则直接instance.xxx = xxx
             *          properties: {
             *              model: { $ref: 'ListModel' },
             *              view: { $ref: 'ListView' },
             *              name: 'xxxx'
             *          }
             *      });
             *
             */
            Context.prototype.addComponent = function (id, config) {
                var ids = [];
                if (typeof id === 'string') {
                    var conf = {};
                    conf[id] = config;
                    this.addComponent(conf);
                }
                else {
                    for (var k in id) {
                        if (this.components[id]) {
                            u.warn(id + ' has been add! This will be no effect');
                            continue;
                        }
                        this.components[k] = createComponent.call(this, k, id[k]);
                        ids.push(k);
                    }
                }

                for (var i = ids.length - 1; i > -1; --i) {
                    var component = this.getComponentConfig(ids[i]);
                    !component.anonyDeps && transferAnonymousComponents(this, component);
                    component.argDeps = this.parser.getDepsFromArgs(component.args);
                    component.propDeps = this.parser.getDepsFromProperties(component.properties);
                }
            };

            Context.prototype.getComponent = function (ids, cb) {
                ids = ids instanceof Array ? ids : [ids];
                var needModules = {};
                var me = this;
                var parser = me.parser;
                for (var i = 0, len = ids.length; i < len; ++i) {
                    var type = ids[i];
                    var component = this.components[type];
                    if (!component) {
                        u.warn('`%s` has not been added to the Ioc', type);
                    }
                    else {
                        needModules = parser.getDependentModules(component, needModules, component.argDeps);
                    }
                }

                loadComponentModules(this, needModules, u.bind(createInstances, this, ids, cb));

                return this;
            };

            Context.prototype.getComponentConfig = function (id) {
                return this.components[id];
            };

            Context.prototype.loader = function (loader) {
                this.moduleLoader = loader;
            };

            /**
             * 销毁容器，会遍历容器中的单例，如果有设置dispose，调用他们的 dispose 方法
             */
            Context.prototype.dispose = function () {
                this.container.dispose();
                this.components = null;
                this.parser = null;
            };

            function createComponent(id, config) {
                var component = {
                    id: id,
                    args: config.args || [],
                    properties: config.properties || {},
                    anonyDeps: null,
                    argDeps: null,
                    propDeps: null,
                    setterDeps: null,
                    scope: config.scope || 'transient',
                    creator: config.creator || null,
                    module: config.module || undefined,
                    isFactory: !!config.isFactory,
                    auto: !!config.auto,
                    instance: null
                };

                // creator为函数，那么先包装下
                typeof component.creator === 'function' && createCreator(component);

                return component;
            }

            function createCreator(component, module) {
                var creator = component.creator = component.creator || module;

                if (typeof creator === 'string') {
                    var method = module[creator];
                    var moduleFactory = function () {
                        return method.apply(module, arguments);
                    };

                    creator = (!component.isFactory || component.scope === 'static') ? method : moduleFactory;
                    component.creator = creator;
                }

                // 给字面量组件和非工厂组件套一层 creator，后面构造实例就可以无需分支判断，直接调用 component.creator
                if (!component.isFactory && component.scope !== 'static') {
                    component.creator = function () {
                        creatorWrapper.prototype = creator.prototype;
                        return new creatorWrapper(creator, arguments);
                    };
                }
            }

            function createAnonymousComponent(context, component, config, idPrefix) {
                var importId = config.$import;
                var refConfig = context.getComponentConfig(importId);
                if (!refConfig) {
                    throw new Error('$import `%s` component, but it is not exist, please check!!', config.$import);
                }

                var id = component.id + '-' + idPrefix + importId;
                config.id = id = (id.indexOf(ANONY_PREFIX) !== -1 ? '' : ANONY_PREFIX) + id;
                delete config.$import;
                context.addComponent(id, u.merge(refConfig, config));

                return id;
            }

            /**
             * 抽取匿名构件
             * @ignored
             * @param {Context} context
             * @param {Object} component
             */
            function transferAnonymousComponents(context, component) {
                component.anonyDeps = [];
                var args = component.args;
                var id = null;
                for (var i = args.length - 1; i > -1; --i) {
                    if (u.hasImport(args[i])) {
                        // 给匿名组件配置生成一个 ioc 构件id
                        id = createAnonymousComponent(context, component, args[i], '$arg.');
                        args[i] = { $ref: id };
                        component.anonyDeps.push(id);
                    }
                }

                var props = component.properties;
                for (var k in props) {
                    if (u.hasImport(props[k])) {
                        id = createAnonymousComponent(context, component, props[k], '$prop.');
                        props[k] = { $ref: id };
                        component.anonyDeps.push(id);
                    }
                }
            }

            function loadComponentModules(context, moduleMaps, cb) {
                var modules = [];
                for (var k in moduleMaps) {
                    modules.push(k);
                }

                context.moduleLoader(modules, function () {
                    for (var i = arguments.length - 1; i > -1; --i) {
                        var module = arguments[i];
                        var components = moduleMaps[modules[i]];
                        for (var j = components.length - 1; j > -1; --j) {
                            var component = components[j];
                            typeof component.creator !== 'function' && createCreator(component, module);
                        }
                    }
                    cb();
                });
            }

            function createInstances(ids, cb) {
                var instances = Array(ids.length);
                if (ids.length === 0) {
                    return cb.apply(null, instances);
                }

                var container = this.container;
                var parser = this.parser;
                var context = this;
                var needModules = {};
                var count = ids.length;
                var done = function () {
                    --count === 0 && cb.apply(null, instances);
                };


                var task = function (index, component) {
                    return function (instance) {
                        instances[index] = instance;
                        if (component) {
                            needModules = parser.getDependentModules(component, {}, component.propDeps);

                            // 获取 setter 依赖
                            if (!component.setterDeps && component.auto) {
                                component.setterDeps = parser.getDepsFromSetters(instance, component.properties);
                                needModules = parser.getDependentModules(component, needModules, component.setterDeps);
                            }

                            loadComponentModules(
                                context, needModules, u.bind(injectDeps, context, instance, component, done)
                            );
                        }
                        else {
                            done();
                        }
                    };
                };

                for (var i = ids.length - 1; i > -1; --i) {
                    var component = this.components[ids[i]];
                    container.createInstance(component, task(i, component));
                }
            }

            function injectDeps(instance, component, cb) {
                var complete = {
                    prop: false,
                    setter: false
                };
                var injected = function (type) {
                    complete[type] = true;
                    complete.prop && complete.setter && cb();
                };
                injectPropDependencies(this, instance, component, u.bind(injected, null, 'prop'));
                injectSetterDependencies(this, instance, component, u.bind(injected, null, 'setter'));
            }

            function injectSetterDependencies(context, instance, component, cb) {
                var deps = component.setterDeps || [];
                context.getComponent(deps, function () {
                    for (var i = deps.length - 1; i > -1; --i) {
                        var dep = deps[i];
                        setProperty(instance, dep, arguments[i]);
                    }
                    cb();
                });
            }

            function injectPropDependencies(context, instance, component, cb) {
                var deps = component.propDeps;
                var props = component.properties;
                context.getComponent(deps, function () {
                    for (var k in props) {
                        var value = props[k];
                        if (u.hasReference(value)) {
                            value = arguments[u.indexOf(deps, value.$ref)];
                        }
                        setProperty(instance, k, value);
                    }
                    cb();
                });
            }

            function setProperty(instance, key, value) {
                var name = 'set' + key.charAt(0).toUpperCase() + key.slice(1);
                typeof instance[name] === 'function' ? instance[name](value) : (instance[key] = value);
            }

            return Context;
        }
    );

}(typeof define === 'function' && define.amd ? define : function (factory) { module.exports = factory; }, this);