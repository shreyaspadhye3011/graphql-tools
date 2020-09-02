import { GraphQLSchema, GraphQLFieldConfig } from 'graphql';

import { Request } from '@graphql-tools/utils';

import { Transform, DelegationContext } from '@graphql-tools/delegate';

import TransformRootFields from './TransformRootFields';

export default class RenameRootFields implements Transform {
  private readonly transformer: TransformRootFields;

  constructor(
    renamer: (
      operation: 'Query' | 'Mutation' | 'Subscription',
      name: string,
      fieldConfig: GraphQLFieldConfig<any, any>
    ) => string
  ) {
    this.transformer = new TransformRootFields(
      (
        operation: 'Query' | 'Mutation' | 'Subscription',
        fieldName: string,
        fieldConfig: GraphQLFieldConfig<any, any>
      ) => [renamer(operation, fieldName, fieldConfig), fieldConfig]
    );
  }

  public transformSchema(originalSchema: GraphQLSchema): GraphQLSchema {
    return this.transformer.transformSchema(originalSchema);
  }

  public transformRequest(
    originalRequest: Request,
    delegationContext: DelegationContext,
    transformationContext: Record<string, any>
  ): Request {
    return this.transformer.transformRequest(originalRequest, delegationContext, transformationContext);
  }
}
