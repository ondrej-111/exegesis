import Ajv from 'ajv';
import traveseSchema from 'json-schema-traverse';
import { CustomFormats, IValidationError, ParameterLocation, ValidatorFunction } from '../../types';
import { resolveRef } from '../../utils/json-schema-resolve-ref';
import * as jsonSchema from '../../utils/jsonSchema';
import Oas3CompileContext from '../Oas3CompileContext';
import { MimeTypeRegistry } from '../../utils/mime';

// urlencoded and form-data requests do not contain any type information;
// for example `?foo=9` doesn't tell us if `foo` is the number 9, or the string
// "9", so we need to use type coercion to make sure the data passed in matches
// our schema.
const REQUEST_TYPE_COERCION_ALLOWED = new MimeTypeRegistry<boolean>({
    "application/x-www-form-urlencoded": true,
    "multipart/form-data": true,
});

// TODO tests
// * readOnly
// * readOnly with additionalProperties and value supplied
// * readOnly not supplied but required
// * writeOnly (all cases as readOnly)
// * Make sure validation errors are correct format.

function assertNever(x: never): never {
    throw new Error("Unexpected object: " + x);
}

function getParameterDescription(
    parameterLocation: ParameterLocation
) {
    let description = '';
    switch(parameterLocation.in) {
        case 'path':
        case 'server':
        case 'query':
        case 'cookie':
        case 'header':
            description = `${parameterLocation.in} parameter "${parameterLocation.name}"`;
            break;
        case 'request':
        case 'response':
            description = `${parameterLocation.in} body`;
            break;
        default:
            assertNever(parameterLocation.in);
    }

    return description;
}

function addCustomFormats(ajv: Ajv.Ajv, customFormats: CustomFormats) : {[k: string]: Ajv.FormatDefinition} {
    return Object.keys(customFormats)
        .reduce<{[k: string]: Ajv.FormatDefinition}>((
            result: {[k: string]: Ajv.FormatDefinition},
            key: string
        ) => {
            const customFormat = customFormats[key];
            if(typeof customFormat === 'function' || customFormat instanceof RegExp) {
                result[key] = {type: 'string', validate: customFormat};
            } else if(customFormat.type === 'string') {
                result[key] = {type: 'string', validate: customFormat.validate};
            } else if(customFormat.type === 'number') {
                result[key] = {type: 'number', validate: customFormat.validate};
            }

            ajv.addFormat(key, result[key]);
            return result;
        }, {});
}

function removeExamples(schema: any) {
    // ajv will print "schema id ignored" to stdout if an example contains a filed
    // named "id", so just axe all the examples.
    traveseSchema(schema, (childSchema: any) => {
        if(childSchema.example) {
            delete childSchema.example;
        }
    });
}

function removeReadOnly(schema: any) {
  traveseSchema(schema, (childSchema: any) => {
      if(childSchema.properties) {
        Object.keys(childSchema.properties).map((key) => {
            if(childSchema.properties[key].readOnly) {
                delete childSchema.properties[key];
            }
        });
      }
  });
}

export function _fixNullables(schema: any) {
    traveseSchema(schema, (childSchema: any) => {
        if(schema.properties) {
            for(const propName of Object.keys(childSchema.properties)) {
                const prop = childSchema.properties[propName];
                const resolvedProp = resolveRef(schema, prop);
                if(resolvedProp.nullable) {
                    childSchema.properties[propName] = {anyOf: [{type: 'null'}, prop]};
                }
            }
        }
        if(childSchema.additionalProperties) {
            const resolvedProp = resolveRef(schema, childSchema.additionalProperties);
            if(resolvedProp.nullable) {
                childSchema.additionalProperties = {anyOf: [{type: 'null'}, childSchema.additionalProperties]};
            }
        }
        if(childSchema.items) {
            const resolvedItems = resolveRef(schema, childSchema.items);
            if(resolvedItems.nullable) {
                childSchema.items = {anyOf: [{type: 'null'}, childSchema.items]};
            }
        }
    });
}

export function _filterRequiredProperties(schema: any, propNameToFilter: string) {
    traveseSchema(schema, (childSchema: any) => {
        if(childSchema.properties && childSchema.required) {
            for(const propName of Object.keys(childSchema.properties)) {
                const prop = childSchema.properties[propName];

                // Resolve the prop, in case it's a `{$ref: ....}`.
                const resolvedProp = resolveRef(schema, prop);

                if(resolvedProp && resolvedProp[propNameToFilter]) {
                    childSchema.required = childSchema.required.filter((r: string) => r !== propName);
                }
            }
        }
    });
}

function doValidate(
    schemaPtr: string,
    parameterLocation: ParameterLocation,
    parameterRequired: boolean,
    ajvValidate: Ajv.ValidateFunction,
    json: any
) {
    const value = {value: json};
    let errors : IValidationError[] | null = null;

    if(json === null || json === undefined) {
        if(parameterRequired) {
            errors = [{
                message: `Missing required ${getParameterDescription(parameterLocation)}`,
                location: {
                    in: parameterLocation.in,
                    name: parameterLocation.name,
                    // docPath comes from parameter here, not schema, since the parameter
                    // is the one that defines it is required.
                    docPath: parameterLocation.docPath,
                    path: ''
                }
            }];
        }
    }

    if(!errors) {
        ajvValidate(value);
        if(ajvValidate.errors) {
            errors = ajvValidate.errors.map(err => {
                let pathPtr = err.dataPath || '';
                if(pathPtr.startsWith("/value")) {
                    pathPtr = pathPtr.slice(6);
                }

                return {
                    message: err.message || 'Unspecified error',
                    location: {
                        in: parameterLocation.in,
                        name: parameterLocation.name,
                        docPath: schemaPtr,
                        path: pathPtr
                    },
                    ajvError: err
                };
            });
        }
    }

    return {errors, value: value.value};
}

function generateValidator(
    schemaContext: Oas3CompileContext,
    parameterLocation: ParameterLocation,
    parameterRequired: boolean,
    propNameToFilter: string,
    allowTypeCoercion: boolean
) : ValidatorFunction {
    const {openApiDoc, jsonPointer: schemaPtr} = schemaContext;
    const customFormats = schemaContext.options.customFormats;

    let schema: any = jsonSchema.extractSchema(openApiDoc, schemaPtr);
    _filterRequiredProperties(schema, propNameToFilter);
    removeExamples(schema);
    // TODO: Should we do this?  Or should we rely on the schema being correct in the first place?
    // _fixNullables(schema);

    // So that we can replace the "root" value of the schema using ajv's type coercion...
    traveseSchema(schema, node => {
        if(node.$ref) {
            node.$ref = `#/properties/value/${node.$ref.slice(2)}`;
        }
    });
    schema = {
        type: 'object',
        properties: {
            value: schema
        }
    };

    if(['post', 'put'].includes(schemaContext.path[2])) {
        removeReadOnly(schema);
    }

    const ajv = new Ajv({
        useDefaults: true,
        coerceTypes: allowTypeCoercion ? 'array' : false,
        removeAdditional: false,
        jsonPointers: true,
        nullable: true,
        allErrors: schemaContext.options.allErrors,
    });
    addCustomFormats(ajv, customFormats);
    const validate = ajv.compile(schema);

    return function(json: any) {
        return doValidate(schemaPtr, parameterLocation, parameterRequired, validate, json);
    };
}

export function generateRequestValidator(
    schemaContext: Oas3CompileContext,
    parameterLocation: ParameterLocation,
    parameterRequired: boolean,
    mediaType: string,
) : ValidatorFunction {
    const allowTypeCoercion = mediaType ? REQUEST_TYPE_COERCION_ALLOWED.get(mediaType) || false : false;
    return generateValidator(schemaContext, parameterLocation, parameterRequired, 'readOnly', allowTypeCoercion);
}

export function generateResponseValidator(
    schemaContext: Oas3CompileContext,
    parameterLocation: ParameterLocation,
    parameterRequired: boolean
) : ValidatorFunction {
    return generateValidator(schemaContext, parameterLocation, parameterRequired, 'writeOnly', false);
}
