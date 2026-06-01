import { z } from 'zod/v4'
import type { Tool } from 'src/Tool.js'
declare const questionOptionSchema: () => z.ZodObject<
  {
    label: z.ZodString
    description: z.ZodString
    preview: z.ZodOptional<z.ZodString>
  },
  z.core.$strip
>
declare const questionSchema: () => z.ZodObject<
  {
    question: z.ZodString
    header: z.ZodString
    options: z.ZodArray<
      z.ZodObject<
        {
          label: z.ZodString
          description: z.ZodString
          preview: z.ZodOptional<z.ZodString>
        },
        z.core.$strip
      >
    >
    multiSelect: z.ZodDefault<z.ZodBoolean>
  },
  z.core.$strip
>
declare const inputSchema: () => z.ZodObject<
  {
    answers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>
    annotations: z.ZodOptional<
      z.ZodRecord<
        z.ZodString,
        z.ZodObject<
          {
            preview: z.ZodOptional<z.ZodString>
            notes: z.ZodOptional<z.ZodString>
          },
          z.core.$strip
        >
      >
    >
    metadata: z.ZodOptional<
      z.ZodObject<
        {
          source: z.ZodOptional<z.ZodString>
        },
        z.core.$strip
      >
    >
    questions: z.ZodArray<
      z.ZodObject<
        {
          question: z.ZodString
          header: z.ZodString
          options: z.ZodArray<
            z.ZodObject<
              {
                label: z.ZodString
                description: z.ZodString
                preview: z.ZodOptional<z.ZodString>
              },
              z.core.$strip
            >
          >
          multiSelect: z.ZodDefault<z.ZodBoolean>
        },
        z.core.$strip
      >
    >
  },
  z.core.$strict
>
type InputSchema = ReturnType<typeof inputSchema>
declare const outputSchema: () => z.ZodObject<
  {
    questions: z.ZodArray<
      z.ZodObject<
        {
          question: z.ZodString
          header: z.ZodString
          options: z.ZodArray<
            z.ZodObject<
              {
                label: z.ZodString
                description: z.ZodString
                preview: z.ZodOptional<z.ZodString>
              },
              z.core.$strip
            >
          >
          multiSelect: z.ZodDefault<z.ZodBoolean>
        },
        z.core.$strip
      >
    >
    answers: z.ZodRecord<z.ZodString, z.ZodString>
    annotations: z.ZodOptional<
      z.ZodRecord<
        z.ZodString,
        z.ZodObject<
          {
            preview: z.ZodOptional<z.ZodString>
            notes: z.ZodOptional<z.ZodString>
          },
          z.core.$strip
        >
      >
    >
  },
  z.core.$strip
>
type OutputSchema = ReturnType<typeof outputSchema>
export declare const _sdkInputSchema: () => z.ZodObject<
  {
    answers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>
    annotations: z.ZodOptional<
      z.ZodRecord<
        z.ZodString,
        z.ZodObject<
          {
            preview: z.ZodOptional<z.ZodString>
            notes: z.ZodOptional<z.ZodString>
          },
          z.core.$strip
        >
      >
    >
    metadata: z.ZodOptional<
      z.ZodObject<
        {
          source: z.ZodOptional<z.ZodString>
        },
        z.core.$strip
      >
    >
    questions: z.ZodArray<
      z.ZodObject<
        {
          question: z.ZodString
          header: z.ZodString
          options: z.ZodArray<
            z.ZodObject<
              {
                label: z.ZodString
                description: z.ZodString
                preview: z.ZodOptional<z.ZodString>
              },
              z.core.$strip
            >
          >
          multiSelect: z.ZodDefault<z.ZodBoolean>
        },
        z.core.$strip
      >
    >
  },
  z.core.$strict
>
export declare const _sdkOutputSchema: () => z.ZodObject<
  {
    questions: z.ZodArray<
      z.ZodObject<
        {
          question: z.ZodString
          header: z.ZodString
          options: z.ZodArray<
            z.ZodObject<
              {
                label: z.ZodString
                description: z.ZodString
                preview: z.ZodOptional<z.ZodString>
              },
              z.core.$strip
            >
          >
          multiSelect: z.ZodDefault<z.ZodBoolean>
        },
        z.core.$strip
      >
    >
    answers: z.ZodRecord<z.ZodString, z.ZodString>
    annotations: z.ZodOptional<
      z.ZodRecord<
        z.ZodString,
        z.ZodObject<
          {
            preview: z.ZodOptional<z.ZodString>
            notes: z.ZodOptional<z.ZodString>
          },
          z.core.$strip
        >
      >
    >
  },
  z.core.$strip
>
export type Question = z.infer<ReturnType<typeof questionSchema>>
export type QuestionOption = z.infer<ReturnType<typeof questionOptionSchema>>
export type Output = z.infer<OutputSchema>
export declare const AskUserQuestionTool: Tool<InputSchema, Output>
export {}
