// @flow
import R from 'ramda';
import Capsule from '@bit/bit.capsule-dev.core.capsule';
import createCapsule from './capsule-factory';
import Consumer from '../consumer/consumer';
import { Scope, ComponentWithDependencies } from '../scope';
import { BitId } from '../bit-id';
import ManyComponentsWriter from '../consumer/component-ops/many-components-writer';
import logger from '../logger/logger';
import loadFlattenedDependencies from '../consumer/component-ops/load-flattened-dependencies';
import { getAllRootDirectoriesFor } from '../npm-client/install-packages';

export default class Isolator {
  capsule: Capsule;
  consumer: ?Consumer;
  scope: Scope;
  constructor(capsule: Capsule, scope: Scope, consumer?: Consumer) {
    this.capsule = capsule;
    this.scope = scope;
    this.consumer = consumer;
  }

  static async getInstance(containerType: string = 'fs', scope: Scope, consumer?: Consumer) {
    logger.debug(`Isolator.getInstance, creating a capsule with an ${containerType} container`);
    const capsule = await createCapsule(containerType);
    return new Isolator(capsule, scope, consumer);
  }

  async writeComponent(id: BitId, opts: Object) {
    const componentWithDependencies = await this.loadComponent(id);
    const writeToPath = opts.writeToPath;
    const concreteOpts = {
      // consumer: this.consumer,
      componentsWithDependencies: [componentWithDependencies],
      writeToPath,
      override: opts.override,
      writePackageJson: !opts.noPackageJson,
      writeConfig: opts.conf,
      writeBitDependencies: opts.writeBitDependencies,
      createNpmLinkFiles: opts.createNpmLinkFiles,
      saveDependenciesAsComponents: opts.saveDependenciesAsComponents !== false,
      writeDists: opts.dist,
      installNpmPackages: !!opts.installPackages, // convert to boolean
      installPeerDependencies: !!opts.installPackages, // convert to boolean
      addToRootPackageJson: false,
      verbose: opts.verbose,
      excludeRegistryPrefix: !!opts.excludeRegistryPrefix,
      silentPackageManagerResult: opts.silentPackageManagerResult,
      isolated: true,
      capsule: this.capsule
    };
    const manyComponentsWriter = new ManyComponentsWriter(concreteOpts);
    logger.debug('ManyComponentsWriter, writeAllToIsolatedCapsule');
    await manyComponentsWriter._populateComponentsFilesToWrite();
    await manyComponentsWriter._populateComponentsDependenciesToWrite();
    await this._persistComponentsDataToCapsule([componentWithDependencies]);
    logger.debug('ManyComponentsWriter, install packages on capsule');
    const allRootDirs = getAllRootDirectoriesFor([componentWithDependencies]);
    await this.installPackagesOnDirs(allRootDirs);
    const links = await manyComponentsWriter._getAllLinks();
    await links.persistAllToCapsule(this.capsule);
    throw new Error('stop here for now');
  }

  /**
   * To write a component into an isolated environment, we need not only its dependencies, but
   * also the dependencies of its dependencies and so on.
   * When loading a component from the model, it's easy to get them all from the
   * flattenedDependencies. However, when loading from the consumer, we have only the dependencies
   * loaded, not the flattened. To get the flattened, we have to load the dependencies and each one
   * of the dependency we need to load its dependencies as well until we got them all.
   */
  async loadComponent(id: BitId): Promise<ComponentWithDependencies> {
    return this.consumer ? await this.loadComponentFromConsumer(id) : await this.loadComponentFromScope(id);
  }

  async loadComponentFromConsumer(id: BitId): Promise<ComponentWithDependencies> {
    const consumer = this.consumer;
    if (!consumer) throw new Error('missing consumer');
    const component = await consumer.loadComponent(id);
    return loadFlattenedDependencies(consumer, component);
  }

  async loadComponentFromScope(id: BitId): Promise<ComponentWithDependencies> {}

  async _persistComponentsDataToCapsule(componentsWithDependencies: ComponentWithDependencies[]) {
    const persistP = componentsWithDependencies.map((componentWithDeps) => {
      const allComponents = [componentWithDeps.component, ...componentWithDeps.allDependencies];
      return allComponents.map((component) => {
        return component.dataToPersist ? component.dataToPersist.persistAllToCapsule(this.capsule) : Promise.resolve();
      });
    });
    return Promise.all(R.flatten(persistP));
  }

  async installPackagesOnDirs(dirs: string[]) {
    return Promise.all(dirs.map(dir => this.installPackagesOnOneDirectory(dir)));
  }

  async installPackagesOnOneDirectory(directory: string) {
    const execResults = await this.capsule.exec('npm install', { cwd: directory });
    let output = '';
    return new Promise((resolve, reject) => {
      execResults.stdout.on('data', (data: string) => {
        output += data;
      });
      execResults.stdout.on('error', (error: string) => {
        console.log('on error', error);
        return reject(error);
      });
      // @ts-ignore
      execResults.on('close', () => {
        console.log('close ', output);
        return resolve(output);
      });
    });
  }
}