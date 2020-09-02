import { GraphQLSchema, GraphQLFieldConfig } from 'graphql';

import { valueMatchesCriteria } from '@graphql-tools/utils';

import { Transform } from '@graphql-tools/delegate';

import FilterObjectFields from './FilterObjectFields';

export default class RemoveObjectFieldsWithDeprecation implements Transform {
  private readonly transformer: FilterObjectFields;

  constructor(reason: string | RegExp) {
    this.transformer = new FilterObjectFields(
      (_typeName: string, _fieldName: string, fieldConfig: GraphQLFieldConfig<any, any>) => {
        if (fieldConfig.deprecationReason) {
          return !valueMatchesCriteria(fieldConfig.deprecationReason, reason);
        }
        return true;
      }
    );
  }

  public transformSchema(originalSchema: GraphQLSchema): GraphQLSchema {
    return this.transformer.transformSchema(originalSchema);
  }
}
