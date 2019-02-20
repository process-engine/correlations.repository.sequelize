import {Logger} from 'loggerhythm';
import * as Sequelize from 'sequelize';

import {IDisposable} from '@essential-projects/bootstrapper_contracts';
import {NotFoundError} from '@essential-projects/errors_ts';
import {IIdentity} from '@essential-projects/iam_contracts';
import {SequelizeConnectionManager} from '@essential-projects/sequelize_connection_manager';

import {CorrelationFromRepository, CorrelationState, ICorrelationRepository} from '@process-engine/correlation.contracts';

import {loadModels} from './model_loader';

import {Correlation, ICorrelationAttributes} from './schemas';

const logger: Logger = new Logger('processengine:persistence:correlation_repository');

export class CorrelationRepository implements ICorrelationRepository, IDisposable {

  public config: Sequelize.Options;

  private _correlation: Sequelize.Model<Correlation, ICorrelationAttributes>;
  private _sequelize: Sequelize.Sequelize;
  private _connectionManager: SequelizeConnectionManager;

  constructor(connectionManager: SequelizeConnectionManager) {
    this._connectionManager = connectionManager;
  }

  private get correlation(): Sequelize.Model<Correlation, ICorrelationAttributes> {
    return this._correlation;
  }

  public async initialize(): Promise<void> {
    logger.verbose('Initializing Sequelize connection and loading models...');
    const connectionAlreadyEstablished: boolean = this._sequelize !== undefined;
    if (connectionAlreadyEstablished) {
      logger.verbose('Repository already initialized. Done.');

      return;
    }
    this._sequelize = await this._connectionManager.getConnection(this.config);
    await loadModels(this._sequelize);

    this._correlation = this._sequelize.models.Correlation;
    logger.verbose('Done.');
  }

  public async dispose(): Promise<void> {
    logger.verbose('Disposing connection');
    await this._connectionManager.destroyConnection(this.config);
    this._sequelize = undefined;
    logger.verbose('Done.');
  }

  public async createEntry(identity: IIdentity,
                           correlationId: string,
                           processInstanceId: string,
                           processModelId: string,
                           processModelHash: string,
                           parentProcessInstanceId?: string): Promise<void> {

    const createParams: any = {
      correlationId: correlationId,
      processInstanceId: processInstanceId,
      processModelId: processModelId,
      parentProcessInstanceId: parentProcessInstanceId,
      processModelHash: processModelHash,
      identity: JSON.stringify(identity),
      state: CorrelationState.running,
    };

    await this.correlation.create(createParams);
  }

  public async getAll(): Promise<Array<CorrelationFromRepository>> {

    const correlations: Array<Correlation> = await this.correlation.findAll();

    const correlationsRuntime: Array<CorrelationFromRepository> = correlations.map(this._convertTocorrelationRuntimeObject.bind(this));

    return correlationsRuntime;
  }

  public async getByCorrelationId(correlationId: string): Promise<Array<CorrelationFromRepository>> {

    const queryParams: Sequelize.FindOptions<ICorrelationAttributes> = {
      where: {
        correlationId: correlationId,
      },
      order: [ [ 'createdAt', 'ASC' ]],
    };

    const correlations: Array<Correlation> = await this.correlation.findAll(queryParams);

    const noCorrelationsFound: boolean = !correlations || correlations.length === 0;
    if (noCorrelationsFound) {
      throw new NotFoundError(`Correlation with id "${correlationId}" not found.`);
    }

    const correlationsRuntime: Array<CorrelationFromRepository> = correlations.map(this._convertTocorrelationRuntimeObject.bind(this));

    return correlationsRuntime;
  }

  public async getByProcessModelId(processModelId: string): Promise<Array<CorrelationFromRepository>> {

    const queryParams: Sequelize.FindOptions<ICorrelationAttributes> = {
      where: {
        processModelId: processModelId,
      },
      order: [ [ 'createdAt', 'ASC' ]],
    };

    const correlations: Array<Correlation> = await this.correlation.findAll(queryParams);

    const noCorrelationsFound: boolean = !correlations || correlations.length === 0;
    if (noCorrelationsFound) {
      throw new NotFoundError(`No correlations for ProcessModel with ID "${processModelId}" found.`);
    }

    const correlationsRuntime: Array<CorrelationFromRepository> = correlations.map(this._convertTocorrelationRuntimeObject.bind(this));

    return correlationsRuntime;
  }

  public async getByProcessInstanceId(processInstanceId: string): Promise<CorrelationFromRepository> {

    const queryParams: Sequelize.FindOptions<ICorrelationAttributes> = {
      where: {
        processInstanceId: processInstanceId,
      },
    };

    const correlation: Correlation = await this.correlation.findOne(queryParams);

    if (!correlation) {
      throw new NotFoundError(`No correlations for ProcessInstance with ID "${processInstanceId}" found.`);
    }

    const correlationRuntime: CorrelationFromRepository = this._convertTocorrelationRuntimeObject(correlation);

    return correlationRuntime;
  }

  public async getSubprocessesForProcessInstance(processInstanceId: string): Promise<Array<CorrelationFromRepository>> {

    const queryParams: Sequelize.FindOptions<ICorrelationAttributes> = {
      where: {
        parentProcessInstanceId: processInstanceId,
      },
      order: [ [ 'createdAt', 'ASC' ]],
    };

    const correlations: Array<Correlation> = await this.correlation.findAll(queryParams);

    const correlationsRuntime: Array<CorrelationFromRepository> = correlations.map(this._convertTocorrelationRuntimeObject.bind(this));

    return correlationsRuntime;
  }

  public async deleteCorrelationByProcessModelId(processModelId: string): Promise<void> {

    const queryParams: Sequelize.DestroyOptions = {
      where: {
        processModelId: processModelId,
      },
    };

    await this.correlation.destroy(queryParams);
  }

  public async getCorrelationsByState(state: CorrelationState): Promise<Array<CorrelationFromRepository>> {
    const queryParams: Sequelize.FindOptions<ICorrelationAttributes> = {
      where: {
        state: state,
      },
    };

    const matchingCorrelations: Array<Correlation> = await this.correlation.findAll(queryParams);
    const correlationsWithState: Array<CorrelationFromRepository> =
      matchingCorrelations.map(this._convertTocorrelationRuntimeObject.bind(this));

    return correlationsWithState;
  }

  public async finishCorrelation(correlationId: string): Promise<void> {
    const queryParams: Sequelize.FindOptions<ICorrelationAttributes> = {
      where: {
        correlationId: correlationId,
      },
    };

    const correlationWithId: Correlation = await this.correlation.findOne(queryParams);

    const noMatchingCorrelationFound: boolean = correlationWithId === undefined;
    if (noMatchingCorrelationFound) {
      throw new NotFoundError(`No matching correlation with ID ${correlationId} found!`);
    }

    correlationWithId.state = CorrelationState.finished;

    await correlationWithId.save();
  }

  public async finishWithError(correlationId: string, error: Error): Promise<void> {
    const queryParams: Sequelize.FindOptions<ICorrelationAttributes> = {
      where: {
        correlationId: correlationId,
      },
    };

    const correlationWithId: Correlation = await this.correlation.findOne(queryParams);

    const noMatchingCorrelationFound: boolean = correlationWithId === undefined;
    if (noMatchingCorrelationFound) {
      throw new NotFoundError(`No matching correlation with ID ${correlationId} found!`);
    }

    correlationWithId.state = CorrelationState.error;
    correlationWithId.error = JSON.stringify(error);

    await correlationWithId.save();
  }

  /**
   * Takes a Correlation object as it was retrieved from the database
   * and convertes it into a Runtime object usable by the ProcessEngine.
   *
   * @param   dataModel The correlation data retrieved from the database.
   * @returns           The ProcessEngine runtime object describing a
   *                    correlation.
   */
  private _convertTocorrelationRuntimeObject(dataModel: Correlation): CorrelationFromRepository {

    const correlation: CorrelationFromRepository = new CorrelationFromRepository();
    correlation.id = dataModel.correlationId;
    correlation.processInstanceId = dataModel.processInstanceId;
    correlation.processModelId = dataModel.processModelId;
    correlation.processModelHash = dataModel.processModelHash;
    correlation.parentProcessInstanceId = dataModel.parentProcessInstanceId || undefined;
    correlation.identity = dataModel.identity ? JSON.parse(dataModel.identity) : undefined;
    correlation.createdAt = dataModel.createdAt;
    correlation.updatedAt = dataModel.updatedAt;
    correlation.state = dataModel.state;
    correlation.error = dataModel.error ? JSON.parse(dataModel.error) : undefined;

    return correlation;
  }
}
