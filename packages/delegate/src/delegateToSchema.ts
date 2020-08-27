import {
  subscribe,
  validate,
  GraphQLSchema,
  isSchema,
  FieldDefinitionNode,
  getOperationAST,
  OperationTypeNode,
  OperationDefinitionNode,
  DocumentNode,
  GraphQLOutputType,
  GraphQLObjectType,
} from 'graphql';

import { execute } from 'graphql/experimental';

import isPromise from 'is-promise';

import { mapAsyncIterator, ExecutionResult, isAsyncIterable } from '@graphql-tools/utils';

import {
  IDelegateToSchemaOptions,
  IDelegateRequestOptions,
  SubschemaConfig,
  ExecutionParams,
  StitchingInfo,
  Endpoint,
  Transform,
  Executor,
} from './types';

import { isSubschemaConfig } from './Subschema';
import { createRequestFromInfo, getDelegatingOperation } from './createRequest';
import { Transformer } from './Transformer';

import AggregateError from '@ardatan/aggregate-error';
import { getBatchingExecutor } from './getBatchingExecutor';

export function delegateToSchema(options: IDelegateToSchemaOptions | GraphQLSchema): any {
  if (isSchema(options)) {
    throw new Error(
      'Passing positional arguments to delegateToSchema is deprecated. ' + 'Please pass named parameters instead.'
    );
  }

  const {
    info,
    operationName,
    operation = getDelegatingOperation(info.parentType, info.schema),
    fieldName = info.fieldName,
    returnType = info.returnType,
    selectionSet,
    fieldNodes,
  } = options;

  const request = createRequestFromInfo({
    info,
    operation,
    fieldName,
    selectionSet,
    fieldNodes,
    operationName,
  });

  return delegateRequest({
    ...options,
    request,
    operation,
    fieldName,
    returnType,
  });
}

function getDelegationReturnType(
  targetSchema: GraphQLSchema,
  operation: OperationTypeNode,
  fieldName: string
): GraphQLOutputType {
  let rootType: GraphQLObjectType<any, any>;
  if (operation === 'query') {
    rootType = targetSchema.getQueryType();
  } else if (operation === 'mutation') {
    rootType = targetSchema.getMutationType();
  } else {
    rootType = targetSchema.getSubscriptionType();
  }

  return rootType.getFields()[fieldName].type;
}

export function delegateRequest({
  request,
  schema: subschemaOrSubschemaConfig,
  rootValue,
  info,
  operation,
  fieldName,
  args,
  returnType,
  context,
  transforms = [],
  transformedSchema,
  skipValidation,
  skipTypeMerging,
  binding,
}: IDelegateRequestOptions) {
  let operationDefinition: OperationDefinitionNode;
  let targetOperation: OperationTypeNode;
  let targetFieldName: string;

  if (operation == null) {
    operationDefinition = getOperationAST(request.document, undefined);
    targetOperation = operationDefinition.operation;
  } else {
    targetOperation = operation;
  }

  if (fieldName == null) {
    operationDefinition = operationDefinition ?? getOperationAST(request.document, undefined);
    targetFieldName = ((operationDefinition.selectionSet.selections[0] as unknown) as FieldDefinitionNode).name.value;
  } else {
    targetFieldName = fieldName;
  }

  let targetSchema: GraphQLSchema;
  let targetRootValue: Record<string, any>;
  let subschemaConfig: SubschemaConfig;
  let endpoint: Endpoint;

  let allTransforms: Array<Transform>;
  if (isSubschemaConfig(subschemaOrSubschemaConfig)) {
    subschemaConfig = subschemaOrSubschemaConfig;
    targetSchema = subschemaConfig.schema;
    targetRootValue = rootValue ?? subschemaConfig?.rootValue ?? info?.rootValue;
    allTransforms =
      subschemaOrSubschemaConfig.transforms != null
        ? subschemaOrSubschemaConfig.transforms.concat(transforms)
        : transforms;
    if (subschemaConfig.endpoint != null) {
      const stitchingInfo: StitchingInfo = info?.schema.extensions?.stitchingInfo;
      endpoint = stitchingInfo.endpoints[subschemaConfig.endpoint];
    } else {
      endpoint = subschemaConfig;
    }
  } else {
    targetSchema = subschemaOrSubschemaConfig;
    targetRootValue = rootValue ?? info?.rootValue;
    allTransforms = transforms;
  }

  const stitchingInfo: StitchingInfo = info?.schema.extensions?.stitchingInfo;

  const delegationContext = {
    subschema: subschemaOrSubschemaConfig,
    targetSchema,
    operation: targetOperation,
    fieldName: targetFieldName,
    args,
    context,
    info,
    returnType:
      returnType ?? info?.returnType ?? getDelegationReturnType(targetSchema, targetOperation, targetFieldName),
    transforms: allTransforms,
    transformedSchema:
      transformedSchema ??
      (stitchingInfo ? stitchingInfo.transformedSchemas.get(subschemaOrSubschemaConfig) : targetSchema),
    skipTypeMerging,
  };

  const transformer = new Transformer(delegationContext, binding);

  const processedRequest = transformer.transformRequest(request);

  if (!skipValidation) {
    validateRequest(targetSchema, processedRequest.document);
  }

  if (targetOperation === 'query' || targetOperation === 'mutation') {
    let executor =
      endpoint?.executor || createDefaultExecutor(targetSchema, subschemaConfig?.rootValue || targetRootValue);

    if (endpoint?.batch) {
      executor = getBatchingExecutor(context, endpoint, executor);
    }

    const executionResult = executor({
      ...processedRequest,
      context,
      info,
    });

    if (isAsyncIterable(executionResult)) {
      return asyncIterableToResult(executionResult).then(originalResult => {
        const transformedResult = transformer.transformResult(originalResult);
        transformedResult['ASYNC_ITERABLE'] = executionResult;
        return transformedResult;
      });
    } else if (isPromise(executionResult)) {
      return (executionResult as Promise<ExecutionResult>).then(originalResult =>
        transformer.transformResult(originalResult)
      );
    }
    return transformer.transformResult(executionResult);
  }

  const subscriber =
    endpoint?.subscriber || createDefaultSubscriber(targetSchema, subschemaConfig?.rootValue || targetRootValue);

  return subscriber({
    ...processedRequest,
    context,
    info,
  }).then((subscriptionResult: AsyncIterableIterator<ExecutionResult> | ExecutionResult) => {
    if (isAsyncIterable(subscriptionResult)) {
      // "subscribe" to the subscription result and map the result through the transforms
      return mapAsyncIterator<ExecutionResult, any>(
        subscriptionResult as AsyncIterableIterator<ExecutionResult>,
        originalResult => ({
          [targetFieldName]: transformer.transformResult(originalResult),
        })
      );
    }

    return transformer.transformResult(subscriptionResult as ExecutionResult);
  });
}

function validateRequest(targetSchema: GraphQLSchema, document: DocumentNode) {
  const errors = validate(targetSchema, document);
  if (errors.length > 0) {
    if (errors.length > 1) {
      const combinedError = new AggregateError(errors);
      throw combinedError;
    }
    const error = errors[0];
    throw error.originalError || error;
  }
}

function createDefaultExecutor(schema: GraphQLSchema, rootValue: Record<string, any>): Executor {
  return (({ document, context, variables, info }: ExecutionParams) =>
    execute({
      schema,
      document,
      contextValue: context,
      variableValues: variables,
      rootValue: rootValue ?? info?.rootValue,
    })) as Executor;
}

function createDefaultSubscriber(schema: GraphQLSchema, rootValue: Record<string, any>) {
  return ({ document, context, variables, info }: ExecutionParams) =>
    subscribe({
      schema,
      document,
      contextValue: context,
      variableValues: variables,
      rootValue: rootValue ?? info?.rootValue,
    }) as any;
}

async function asyncIterableToResult(asyncIterable: AsyncIterable<ExecutionResult>): Promise<any> {
  const asyncIterator = asyncIterable[Symbol.asyncIterator]();
  const payload = await asyncIterator.next();
  return payload.value;
}
