import { AlertTriangle, Plus, RotateCcw } from "lucide-react";
import * as React from "react";

import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";

import {
  compileDatabaseFormula,
  type StaticFormulaType,
} from "../lib/databaseFormulaCompiler";
import {
  databaseComputedResultIsList,
  databasePropertyComputedResultType,
  databasePropertyScalarType,
} from "../lib/databaseComputedType";
import type {
  DatabaseComputedResultType,
  DatabaseProperty,
  DatabaseSchema,
  DatabaseSchemaContent,
} from "../lib/databaseSchemaCodec";
import { databasePropertyDefinition } from "../lib/databaseSchemaCodec";
import {
  addDatabaseProperty,
  changeDatabasePropertyType,
} from "../lib/databaseSchemaCommands";
import {
  addDatabaseAuthoritativeRelation,
  addDatabaseMirrorRelation,
  newDatabaseRelationPairPlan,
  type DatabaseRelationPairPlan,
} from "../lib/databaseRelationCommands";
import { DatabaseConflictError } from "../lib/useCommunityDatabases";
import { compareRelayVersions } from "../lib/databaseValue";

type SchemaMutation = (schema: DatabaseSchema) => DatabaseSchema;
type SaveKind = "property" | "relation_source" | "relation_mirror";

type Failure = {
  base?: DatabaseSchema;
  databaseId: string;
  kind: SaveKind;
  message: string;
  mutation: SchemaMutation;
  propertyId?: string;
};

function newerSchema(
  left: DatabaseSchema | undefined,
  right: DatabaseSchema | undefined,
): DatabaseSchema | undefined {
  if (!left) return right;
  if (!right) return left;
  return compareRelayVersions(left, right) >= 0 ? left : right;
}

function schemaFromConflict(error: unknown): DatabaseSchema | undefined {
  return error instanceof DatabaseConflictError && "properties" in error.newest
    ? error.newest
    : undefined;
}

function formulaResultType(
  resultType: StaticFormulaType,
  selected: DatabaseComputedResultType,
): DatabaseComputedResultType {
  if (
    resultType === "number" ||
    resultType === "boolean" ||
    resultType === "date"
  ) {
    return resultType;
  }
  if (resultType === "string") return "text";
  if (resultType === "list") {
    return databaseComputedResultIsList(selected) ? selected : "text_list";
  }
  return selected;
}

function schemaContent(schema: DatabaseSchema): DatabaseSchemaContent {
  return {
    name: schema.name,
    ...(schema.icon ? { icon: schema.icon } : {}),
    properties: schema.properties,
    views: schema.views,
    createdAt: schema.createdAt,
    updatedAt: schema.updatedAt,
  };
}

function propertyId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

/** Adds relation, formula, and rollup properties through explicit atomic saves. */
export function DatabaseComputedPropertyPanel({
  lookupSchema,
  onSaveSchema,
  schema,
  schemas,
}: {
  lookupSchema: (databaseId: string) => Promise<DatabaseSchema | undefined>;
  onSaveSchema: (
    databaseId: string,
    content: DatabaseSchemaContent,
    baseEventId: string,
  ) => Promise<DatabaseSchema>;
  schema: DatabaseSchema;
  schemas: ReadonlyMap<string, DatabaseSchema>;
}) {
  const [open, setOpen] = React.useState(false);
  const [mode, setMode] = React.useState<"formula" | "relation" | "rollup">(
    "relation",
  );
  const [name, setName] = React.useState("");
  const [editingPropertyId, setEditingPropertyId] = React.useState("");
  const [expression, setExpression] = React.useState("");
  const [targetDatabaseId, setTargetDatabaseId] = React.useState(schema.id);
  const [mirrorName, setMirrorName] = React.useState("Related from");
  const [pairPlan, setPairPlan] =
    React.useState<DatabaseRelationPairPlan | null>(null);
  const [pairStep, setPairStep] = React.useState<"source" | "mirror" | "done">(
    "source",
  );
  const [relationPropertyId, setRelationPropertyId] = React.useState("");
  const [targetPropertyId, setTargetPropertyId] = React.useState("");
  const [calculation, setCalculation] = React.useState<
    "count" | "show" | "sum" | "avg" | "min" | "max"
  >("count");
  const [resultType, setResultType] =
    React.useState<DatabaseComputedResultType>("text");
  const [failure, setFailure] = React.useState<Failure | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const schemasRef = React.useRef(schemas);
  schemasRef.current = schemas;

  React.useEffect(() => {
    if (pairStep === "source") setTargetDatabaseId(schema.id);
  }, [pairStep, schema.id]);
  React.useEffect(() => {
    if (pairPlan) return;
    const incomplete = schema.properties.find(
      (property) =>
        property.type === "relation" &&
        property.options.direction === "authoritative" &&
        property.options.mirroredPropertyId &&
        !schemas
          .get(property.options.databaseId)
          ?.properties.some(
            (candidate) =>
              candidate.id === property.options.mirroredPropertyId &&
              candidate.type === "relation" &&
              candidate.options.direction === "mirror" &&
              candidate.options.databaseId === schema.id &&
              candidate.options.mirroredPropertyId === property.id,
          ),
    );
    if (
      incomplete?.type === "relation" &&
      incomplete.options.mirroredPropertyId
    ) {
      setPairPlan({
        sourceDatabaseId: schema.id,
        targetDatabaseId: incomplete.options.databaseId,
        authoritativePropertyId: incomplete.id,
        mirrorPropertyId: incomplete.options.mirroredPropertyId,
      });
      setName(incomplete.name);
      setTargetDatabaseId(incomplete.options.databaseId);
      setPairStep("mirror");
    }
  }, [pairPlan, schema, schemas]);

  const validateMutation = async (
    base: DatabaseSchema,
    next: DatabaseSchema,
    propertyId?: string,
  ): Promise<void> => {
    for (const property of next.properties) {
      if (property.type !== "formula" && property.type !== "rollup") continue;
      const previous = base.properties.find(
        (candidate) => candidate.id === property.id,
      );
      if (
        property.id !== propertyId &&
        JSON.stringify(previous) === JSON.stringify(property)
      ) {
        continue;
      }
      if (property.type === "formula") {
        const compiled = compileDatabaseFormula(
          property.options.expression,
          next.properties,
        );
        if (!compiled.ok) {
          throw new Error(`${compiled.error.code}: ${compiled.error.detail}`);
        }
        const declared = property.options.resultType ?? "text";
        if (
          formulaResultType(compiled.compilation.resultType, declared) !==
          declared
        ) {
          throw new Error(
            "TYPE_MISMATCH: Formula result type no longer matches the expression.",
          );
        }
        continue;
      }
      const relation = next.properties.find(
        (
          candidate,
        ): candidate is Extract<DatabaseProperty, { type: "relation" }> =>
          candidate.id === property.options.relationPropertyId &&
          candidate.type === "relation",
      );
      if (!relation)
        throw new Error("BROKEN_RELATION: Rollup relation is missing.");
      let target =
        relation.options.databaseId === next.id
          ? next
          : schemasRef.current.get(relation.options.databaseId);
      if (!target) target = await lookupSchema(relation.options.databaseId);
      const targetProperty = target?.properties.find(
        (candidate) => candidate.id === property.options.targetPropertyId,
      );
      if (!target || target.deleted || !targetProperty) {
        throw new Error("BROKEN_RELATION: Rollup target is unavailable.");
      }
      if (targetProperty.type === "rollup") {
        throw new Error(
          "TYPE_MISMATCH: A rollup cannot target another rollup.",
        );
      }
      const targetScalar = databasePropertyScalarType(targetProperty);
      if (
        property.options.calculation !== "count" &&
        property.options.calculation !== "show" &&
        targetScalar !== "number"
      ) {
        throw new Error(
          "TYPE_MISMATCH: This rollup calculation requires numeric values.",
        );
      }
      if (property.options.calculation === "show") {
        if (
          targetScalar === "unknown" ||
          (targetProperty.type === "formula" &&
            databaseComputedResultIsList(
              databasePropertyComputedResultType(targetProperty),
            ))
        ) {
          throw new Error(
            "TYPE_MISMATCH: Show rollups require scalar target values.",
          );
        }
        if (property.options.resultType !== `${targetScalar}_list`) {
          throw new Error(
            "TYPE_MISMATCH: Rollup result type no longer matches its target.",
          );
        }
      } else if (property.options.resultType !== "number") {
        throw new Error(
          "TYPE_MISMATCH: Numeric rollups must declare a number result.",
        );
      }
    }
  };

  const saveMutation = async (
    databaseId: string,
    mutation: SchemaMutation,
    kind: SaveKind,
    preferredBase?: DatabaseSchema,
    propertyId?: string,
  ) => {
    if (saving) return;
    setSaving(true);
    setFailure(null);
    setMessage(null);
    try {
      let base = newerSchema(preferredBase, schemasRef.current.get(databaseId));
      if (!base) base = await lookupSchema(databaseId);
      if (!base) {
        setFailure({
          databaseId,
          kind,
          mutation,
          ...(propertyId ? { propertyId } : {}),
          message:
            "The latest database schema is unavailable. Retry to look it up again.",
        });
        return;
      }
      const next = mutation(base);
      await validateMutation(base, next, propertyId);
      await onSaveSchema(databaseId, schemaContent(next), base.eventId);
      if (kind === "relation_source") {
        setPairStep("mirror");
        setMessage(
          "Source relation saved. Confirm the reciprocal property as the second schema action.",
        );
      } else if (kind === "relation_mirror") {
        setPairStep("done");
        setMessage("Reciprocal relation configured.");
      } else {
        setName("");
        setExpression("");
        setEditingPropertyId("");
        setMessage("Property saved.");
      }
    } catch (error) {
      const current = schemasRef.current.get(databaseId);
      const newest = newerSchema(
        schemaFromConflict(error),
        newerSchema(preferredBase, current),
      );
      setFailure({
        ...(newest ? { base: newest } : {}),
        databaseId,
        kind,
        mutation,
        ...(propertyId ? { propertyId } : {}),
        message: schemaFromConflict(error)
          ? "A newer schema was loaded. Retry to apply this property to it."
          : error instanceof Error
            ? error.message
            : "Couldn't save this property.",
      });
    } finally {
      setSaving(false);
    }
  };

  const targetSchema = schemas.get(targetDatabaseId);
  const availableSchemas = [
    ...new Map(
      [...schemas.values()]
        .filter((candidate) => !candidate.deleted)
        .map((candidate) => [candidate.id, candidate]),
    ).values(),
  ];
  const localRelations = schema.properties.filter(
    (property): property is Extract<DatabaseProperty, { type: "relation" }> =>
      property.type === "relation",
  );
  const rollupRelation = localRelations.find(
    (property) => property.id === relationPropertyId,
  );
  const rollupTarget = rollupRelation
    ? schemas.get(rollupRelation.options.databaseId)
    : undefined;
  const configurableProperties = schema.properties.filter((property) =>
    ["formula", "rollup"].includes(property.type),
  );

  const updateProperty = (
    latest: DatabaseSchema,
    property: DatabaseProperty,
  ): DatabaseSchema => {
    if (!latest.properties.some((candidate) => candidate.id === property.id)) {
      return addDatabaseProperty(latest, property);
    }
    const current = latest.properties.find(
      (candidate) => candidate.id === property.id,
    );
    const changed =
      current && current.type !== property.type
        ? changeDatabasePropertyType(
            latest,
            property.id,
            property.type,
            databasePropertyDefinition(property),
          )
        : latest;
    return {
      ...changed,
      properties: changed.properties.map((candidate) =>
        candidate.id === property.id
          ? {
              ...property,
              ...(candidate.priorDefinitions
                ? { priorDefinitions: candidate.priorDefinitions }
                : {}),
            }
          : candidate,
      ),
    };
  };

  const addFormula = () => {
    const propertyName = name.trim() || "Formula";
    const compiled = compileDatabaseFormula(expression, schema.properties);
    if (!compiled.ok) {
      setMessage(`${compiled.error.code}: ${compiled.error.detail}`);
      return;
    }
    const id = editingPropertyId || propertyId("formula");
    void saveMutation(
      schema.id,
      (latest) =>
        updateProperty(latest, {
          id,
          name: propertyName,
          type: "formula",
          options: {
            expression,
            resultType: formulaResultType(
              compiled.compilation.resultType,
              resultType,
            ),
          },
        }),
      "property",
      undefined,
      id,
    );
  };

  const saveRelationSource = () => {
    const plan =
      pairPlan ?? newDatabaseRelationPairPlan(schema.id, targetDatabaseId);
    setPairPlan(plan);
    void saveMutation(
      schema.id,
      (latest) =>
        addDatabaseAuthoritativeRelation(
          latest,
          plan,
          name.trim() || targetSchema?.name || "Relation",
        ),
      "relation_source",
    );
  };

  const saveRelationMirror = () => {
    if (!pairPlan) return;
    void saveMutation(
      pairPlan.targetDatabaseId,
      (latest) => addDatabaseMirrorRelation(latest, pairPlan, mirrorName),
      "relation_mirror",
    );
  };

  const addRollup = () => {
    const relation = localRelations.find(
      (property) => property.id === relationPropertyId,
    );
    if (!relation || !targetPropertyId) {
      setMessage("Choose a relation and target property.");
      return;
    }
    const target = rollupTarget?.properties.find(
      (property) => property.id === targetPropertyId,
    );
    const scalar = target ? databasePropertyScalarType(target) : "unknown";
    const savedResultType: DatabaseComputedResultType =
      calculation === "show"
        ? scalar === "unknown"
          ? databaseComputedResultIsList(resultType)
            ? resultType
            : "text_list"
          : `${scalar}_list`
        : "number";
    const id = editingPropertyId || propertyId("rollup");
    void saveMutation(
      schema.id,
      (latest) =>
        updateProperty(latest, {
          id,
          name: name.trim() || "Rollup",
          type: "rollup",
          options: {
            relationPropertyId,
            targetPropertyId,
            calculation,
            resultType: savedResultType,
          },
        }),
      "property",
      undefined,
      id,
    );
  };

  return (
    <div className="border-b border-border/60 px-4 py-2">
      <Button
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        size="sm"
        type="button"
        variant="ghost"
      >
        <Plus /> Computed property
      </Button>
      {open ? (
        <div className="mt-2 flex max-w-4xl flex-col gap-3 rounded-lg border border-border/60 bg-muted/20 p-3">
          <fieldset className="flex flex-wrap gap-2" aria-label="Property kind">
            {(["relation", "formula", "rollup"] as const).map((kind) => (
              <Button
                aria-pressed={mode === kind}
                key={kind}
                onClick={() => setMode(kind)}
                size="xs"
                type="button"
                variant={mode === kind ? "secondary" : "ghost"}
              >
                {kind === "relation"
                  ? "Relation"
                  : kind === "formula"
                    ? "Formula"
                    : "Rollup"}
              </Button>
            ))}
          </fieldset>
          <select
            aria-label="Computed property to configure"
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            onChange={(event) => {
              const property = schema.properties.find(
                (candidate) => candidate.id === event.target.value,
              );
              setEditingPropertyId(property?.id ?? "");
              if (property?.type === "formula") {
                setMode("formula");
                setName(property.name);
                setExpression(property.options.expression);
                setResultType(property.options.resultType ?? "text");
              }
              if (property?.type === "rollup") {
                setMode("rollup");
                setName(property.name);
                setRelationPropertyId(property.options.relationPropertyId);
                setTargetPropertyId(property.options.targetPropertyId);
                setCalculation(property.options.calculation);
                setResultType(property.options.resultType ?? "text_list");
              }
            }}
            value={editingPropertyId}
          >
            <option value="">Add a new property</option>
            {configurableProperties.map((property) => (
              <option key={property.id} value={property.id}>
                Edit {property.name}
              </option>
            ))}
          </select>
          <Input
            aria-label={`${mode} property name`}
            onChange={(event) => setName(event.target.value)}
            placeholder={`${mode === "relation" ? "Relation" : mode === "formula" ? "Formula" : "Rollup"} name`}
            value={name}
          />
          {mode === "formula" ? (
            <>
              <label
                className="flex flex-col gap-1 text-xs"
                htmlFor="database-formula-expression"
              >
                Formula (dates use UTC)
                <Input
                  aria-label="Formula expression"
                  id="database-formula-expression"
                  onChange={(event) => setExpression(event.target.value)}
                  placeholder={'prop("Effort") * 2'}
                  value={expression}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs">
                Expected result type
                <select
                  aria-label="Formula result type"
                  className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                  onChange={(event) =>
                    setResultType(
                      event.target.value as DatabaseComputedResultType,
                    )
                  }
                  value={resultType}
                >
                  <ComputedResultTypeOptions />
                </select>
              </label>
              <Button
                disabled={saving}
                onClick={addFormula}
                size="sm"
                type="button"
              >
                {editingPropertyId ? "Update formula" : "Save formula"}
              </Button>
            </>
          ) : null}
          {mode === "relation" ? (
            <>
              <label className="flex flex-col gap-1 text-xs">
                Related database
                <select
                  aria-label="Related database"
                  className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                  disabled={pairStep !== "source"}
                  onChange={(event) => {
                    setTargetDatabaseId(event.target.value);
                    setPairPlan(null);
                  }}
                  value={targetDatabaseId}
                >
                  {availableSchemas.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.name}
                    </option>
                  ))}
                </select>
              </label>
              <Input
                aria-label="Reciprocal property name"
                disabled={pairStep === "done"}
                onChange={(event) => setMirrorName(event.target.value)}
                placeholder="Related from"
                value={mirrorName}
              />
              {pairStep === "source" ? (
                <Button
                  disabled={saving || !targetSchema}
                  onClick={saveRelationSource}
                  size="sm"
                  type="button"
                >
                  1. Save source relation
                </Button>
              ) : null}
              {pairStep === "mirror" ? (
                <Button
                  disabled={saving}
                  onClick={saveRelationMirror}
                  size="sm"
                  type="button"
                >
                  2. Create reciprocal property
                </Button>
              ) : null}
              {pairStep === "done" ? (
                <Button
                  onClick={() => {
                    setPairPlan(null);
                    setPairStep("source");
                    setMessage(null);
                  }}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Configure another relation
                </Button>
              ) : null}
            </>
          ) : null}
          {mode === "rollup" ? (
            <>
              <select
                aria-label="Rollup relation"
                className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                onChange={(event) => {
                  setRelationPropertyId(event.target.value);
                  setTargetPropertyId("");
                }}
                value={relationPropertyId}
              >
                <option value="">Choose relation</option>
                {relationPropertyId &&
                !localRelations.some(
                  (property) => property.id === relationPropertyId,
                ) ? (
                  <option value={relationPropertyId}>
                    Missing relation ({relationPropertyId})
                  </option>
                ) : null}
                {localRelations.map((property) => (
                  <option key={property.id} value={property.id}>
                    {property.name}
                  </option>
                ))}
              </select>
              {calculation === "show" ? (
                <label className="flex flex-col gap-1 text-xs">
                  Expected result type
                  <select
                    aria-label="Rollup result type"
                    className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                    onChange={(event) =>
                      setResultType(
                        event.target.value as DatabaseComputedResultType,
                      )
                    }
                    value={resultType}
                  >
                    <ComputedResultTypeOptions listsOnly />
                  </select>
                </label>
              ) : null}
              <select
                aria-label="Rollup target property"
                className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                onChange={(event) => setTargetPropertyId(event.target.value)}
                value={targetPropertyId}
              >
                <option value="">Choose target property</option>
                {targetPropertyId &&
                !rollupTarget?.properties.some(
                  (property) => property.id === targetPropertyId,
                ) ? (
                  <option value={targetPropertyId}>
                    Missing property ({targetPropertyId})
                  </option>
                ) : null}
                {rollupTarget?.properties
                  .filter((property) => property.type !== "rollup")
                  .map((property) => (
                    <option key={property.id} value={property.id}>
                      {property.name}
                    </option>
                  ))}
              </select>
              <select
                aria-label="Rollup calculation"
                className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                onChange={(event) =>
                  setCalculation(event.target.value as typeof calculation)
                }
                value={calculation}
              >
                {(["count", "show", "sum", "avg", "min", "max"] as const).map(
                  (value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ),
                )}
              </select>
              <Button
                disabled={saving}
                onClick={addRollup}
                size="sm"
                type="button"
              >
                {editingPropertyId ? "Update rollup" : "Save rollup"}
              </Button>
            </>
          ) : null}
          {failure ? (
            <div
              className="flex items-center gap-2 text-xs text-destructive"
              role="alert"
            >
              <AlertTriangle className="h-3.5 w-3.5" />
              <span>{failure.message}</span>
              <Button
                aria-label="Retry computed property"
                disabled={saving}
                onClick={() =>
                  void saveMutation(
                    failure.databaseId,
                    failure.mutation,
                    failure.kind,
                    failure.base,
                    failure.propertyId,
                  )
                }
                size="xs"
                type="button"
                variant="outline"
              >
                <RotateCcw /> Retry
              </Button>
            </div>
          ) : message ? (
            <p className="text-xs text-muted-foreground" role="status">
              {message}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ComputedResultTypeOptions({
  listsOnly = false,
}: {
  listsOnly?: boolean;
}) {
  const types: DatabaseComputedResultType[] = listsOnly
    ? ["number_list", "text_list", "boolean_list", "date_list"]
    : [
        "number",
        "text",
        "boolean",
        "date",
        "number_list",
        "text_list",
        "boolean_list",
        "date_list",
      ];
  return types.map((type) => (
    <option key={type} value={type}>
      {type.replace("_", " ")}
    </option>
  ));
}
