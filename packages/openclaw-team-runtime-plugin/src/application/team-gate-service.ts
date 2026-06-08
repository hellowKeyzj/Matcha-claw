import type { TeamGateFailureItem } from '../domain/team-gate.js'

export interface EvaluatedGate {
  gateType: string
  verdict: string
  passed: boolean
  failureItems: TeamGateFailureItem[]
}

const DESIGN_REQUIRED_SECTIONS = [
  'Tiling Strategy',
  'Memory Layout',
  'Data Flow',
  'Interface Specification',
  'Performance Estimation',
] as const

export class TeamGateService {
  evaluate(input: { gateType: string; content: string }): EvaluatedGate {
    switch (input.gateType) {
      case 'design':
        return this.evaluateDesignGate(input.content)
      case 'compile':
        return evaluateKeywordGate({
          gateType: 'compile',
          content: input.content,
          passVerdicts: ['CODE-COMPILABLE'],
          failVerdict: 'CODE-HAS-ERRORS',
        })
      case 'adversary':
        return evaluateKeywordGate({
          gateType: 'adversary',
          content: input.content,
          passVerdicts: ['LOW-RISK', 'ACCEPTABLE-RISK'],
          failVerdict: 'BLOCK',
        })
      case 'precision':
        return evaluateKeywordGate({
          gateType: 'precision',
          content: input.content,
          passVerdicts: ['PRECISION-PASS'],
          failVerdict: 'PRECISION-FAIL',
        })
      case 'performance':
        return evaluateKeywordGate({
          gateType: 'performance',
          content: input.content,
          passVerdicts: ['PERFORMANCE-TARGET-MET', 'PERFORMANCE-IMPROVED'],
          failVerdict: 'PERFORMANCE-NO-GAIN',
        })
      default:
        throw new Error(`Unsupported gate type: ${input.gateType}`)
    }
  }

  private evaluateDesignGate(content: string): EvaluatedGate {
    const failureItems: TeamGateFailureItem[] = []

    for (const section of DESIGN_REQUIRED_SECTIONS) {
      const sectionContent = extractMarkdownSection(content, section)
      if (!sectionContent) {
        failureItems.push({ code: 'section_missing', message: `Missing required design section: ${section}` })
        continue
      }
      const concreteItemCount = countConcreteItems(sectionContent)
      if (concreteItemCount < 3) {
        failureItems.push({
          code: 'section_too_thin',
          message: `Design section ${section} must contain at least 3 concrete items.`,
        })
      }
    }

    if (!/\bDESIGN-COMPLETE\b/.test(content)) {
      failureItems.push({ code: 'verdict_missing', message: 'Design report must include verdict DESIGN-COMPLETE.' })
    }

    return {
      gateType: 'design',
      verdict: failureItems.length === 0 ? 'DESIGN-COMPLETE' : 'DESIGN-INCOMPLETE',
      passed: failureItems.length === 0,
      failureItems,
    }
  }
}

function evaluateKeywordGate(input: {
  gateType: string
  content: string
  passVerdicts: string[]
  failVerdict: string
}): EvaluatedGate {
  const matchedVerdict = input.passVerdicts.find((verdict) => hasVerdict(input.content, verdict))
  if (matchedVerdict) {
    return {
      gateType: input.gateType,
      verdict: matchedVerdict,
      passed: true,
      failureItems: [],
    }
  }

  return {
    gateType: input.gateType,
    verdict: input.failVerdict,
    passed: false,
    failureItems: [{
      code: 'verdict_missing',
      message: `Gate ${input.gateType} requires one of: ${input.passVerdicts.join(', ')}.`,
    }],
  }
}

function hasVerdict(content: string, verdict: string): boolean {
  return new RegExp(`\\b${escapeRegExp(verdict)}\\b`).test(content)
}

function extractMarkdownSection(markdown: string, section: string): string {
  const lines = markdown.split(/\r?\n/)
  const targetHeading = new RegExp(`^#{2,4}\\s+${escapeRegExp(section)}\\s*$`, 'i')
  let collecting = false
  let inFence = false
  const collected: string[] = []

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      if (collecting) {
        collected.push(line)
      }
      inFence = !inFence
      continue
    }

    if (!inFence && targetHeading.test(line)) {
      collecting = true
      continue
    }

    if (collecting && !inFence && /^#{2,4}\s+[^\r\n]+\s*$/.test(line)) {
      break
    }

    if (collecting) {
      collected.push(line)
    }
  }

  return collected.join('\n').trim()
}

function countConcreteItems(markdown: string): number {
  return markdown.split(/\r?\n/).filter((line) => /^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(line)).length
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
