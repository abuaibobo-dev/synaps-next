/**
 * Adaptive Topology Switcher
 * 借鉴 Ruflo adaptive-coordinator：根据任务特征自动选择最优协调拓扑
 */

export type Topology = 'flat' | 'hierarchical' | 'mesh' | 'ring';

export interface TaskCharacteristics {
  complexity: number;
  parallelizability: number;
  interdependencies: number;
  fileCount: number;
  estimatedSteps: number;
  urgency: number;
}

export function analyzeAndRecommend(chars: TaskCharacteristics): {
  topology: Topology;
  confidence: number;
  reasoning: string;
  maxConcurrency: number;
  agentRoles: string[];
} {
  const { complexity, parallelizability, interdependencies, fileCount, estimatedSteps, urgency } = chars;

  if (complexity > 0.8 && interdependencies > 0.7) {
    return {
      topology: 'hierarchical',
      confidence: 0.9,
      reasoning: '任务复杂度高且步骤间强依赖，采用层级式调度确保顺序执行和质量把控',
      maxConcurrency: 1,
      agentRoles: ['scheduler', 'code_engineer', 'reviewer'],
    };
  }

  if (parallelizability > 0.7 && fileCount > 3 && urgency < 0.5) {
    return {
      topology: 'mesh',
      confidence: 0.85,
      reasoning: '多文件可并行处理，采用网状拓扑让多个工程师同时工作',
      maxConcurrency: Math.min(fileCount, 5),
      agentRoles: ['code_engineer', 'code_engineer', 'reviewer'],
    };
  }

  if (interdependencies > 0.6 && estimatedSteps > 3) {
    return {
      topology: 'ring',
      confidence: 0.75,
      reasoning: '步骤间有顺序依赖，采用环形流水线逐步推进',
      maxConcurrency: 1,
      agentRoles: ['code_engineer', 'tester', 'reviewer'],
    };
  }

  return {
    topology: 'flat',
    confidence: 0.7,
    reasoning: '任务相对简单，采用扁平模式直接执行',
    maxConcurrency: 1,
    agentRoles: ['code_engineer'],
  };
}

export function inferCharacteristics(
  taskDescription: string,
  projectStructure: string[],
  previousFailures: number = 0
): TaskCharacteristics {
  const desc = taskDescription.toLowerCase();
  const fileCount = projectStructure.filter(f => !f.startsWith('📁')).length;

  const complexityKeywords = ['重构', '重写', '迁移', '架构', 'refactor', 'rewrite', 'migrate'];
  const complexity = Math.min(1,
    (complexityKeywords.filter(k => desc.includes(k)).length * 0.3) +
    (fileCount > 10 ? 0.3 : fileCount > 5 ? 0.2 : 0) +
    (desc.length > 200 ? 0.2 : 0)
  );

  const parallelKeywords = ['批量', '所有', '全部', '每个', 'batch', 'all', 'every'];
  const parallelizability = Math.min(1,
    (parallelKeywords.filter(k => desc.includes(k)).length * 0.3) +
    (fileCount > 3 ? 0.3 : 0) +
    (desc.includes('并行') || desc.includes('parallel') ? 0.4 : 0)
  );

  const depKeywords = ['然后', '接着', '之后', '依赖', 'then', 'after', 'depends'];
  const interdependencies = Math.min(1,
    (depKeywords.filter(k => desc.includes(k)).length * 0.25) +
    (desc.includes('顺序') || desc.includes('sequential') ? 0.3 : 0) +
    (previousFailures > 2 ? 0.2 : 0)
  );

  const stepKeywords = ['步骤', '阶段', 'phase', 'step'];
  const estimatedSteps = Math.max(1,
    stepKeywords.filter(k => desc.includes(k)).length * 2 +
    (complexity > 0.5 ? 3 : complexity > 0.3 ? 2 : 1)
  );

  const urgencyKeywords = ['紧急', '马上', '立刻', 'urgent', 'asap', 'now'];
  const urgency = Math.min(1,
    urgencyKeywords.filter(k => desc.includes(k)).length * 0.4
  );

  return { complexity, parallelizability, interdependencies, fileCount, estimatedSteps, urgency };
}
