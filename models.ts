import { db, ObjectId, Filter } from 'hydrooj';

// 新增：天梯轮次表
const ladderRoundCollection = db.collection('stages_ladder_round');
const stagesCollection = db.collection('stages');
const challengeCollection = db.collection('stages_challenge');

// ========================================================
// 1. 数据模型与接口定义 (Data Models)
// ========================================================

export interface StagesDoc {
    _id?: ObjectId;
    author: number;         // 发布者 UID
    createdAt: Date;        // 发布日期
    privilege: number;      // 关卡展示顺序权重 (数字越小越靠前)
    type: number;           // 0:黑盒破译, 1:代码找茬, 2:代码拼图, 3:内存劫变, 4:时空刺客
    status: number;         // 0:启用, 1:禁用, 2:隐藏（天梯赛用）
    duration: number;       // 限时时长 (秒)
    maxChances: number;     // 最大限制次数
    reward: number;         // 关卡满额金币奖励基数
    title: string;          // 关卡标题
    problem: string;        // 关卡问题描述
    
    // 🎭 多游戏核心矩阵兼容性字段定义
    codeSnippet?: string;   // 关卡代码 (代码找茬、代码拼图、时空刺客用)
    answer: string;         // 标准答案 (代码找茬的正确行号、内存劫变的正确物理地址、时空刺客的正确复杂度，多答案可用逗号隔开)
    analysis: string;       // 官方漏洞深度复盘解析与正解释义
    
    // 🔎【黑盒破译、内存劫变、时空刺客复用字段】
    hints?: {
        id: number;         // 时空刺客 ID
        text: string;       // 线索文本内容，内存劫变物理地址
        cost: number;       // 解锁该线索需要扣除的奖励金币数
        status: string;     // 内存劫变占用情况
    }[];
    keywords?: string[];    // 关键字列表（玩家输入的答案中包含任意一个关键字即算正确通关）
    ac: number;             // 历史成功通关人数
    tried: number;          // 历史参与挑战人数
}

export interface StagesChallengeDoc {
    _id?: ObjectId;
    uid: number;            // 学生/玩家 UID
    stageId: ObjectId;      // 对应的关卡 ID
    timeUsed: number;       // 通关用时（秒）
    chancesUsed: number;    // 通关已用次数
    status: number;         // 结局状态：0:挑战进行中, 1:挑战成功, 2:次数耗尽失败, 3:超时失败, 4:人工申诉中
    
    // 🎭 挑战进行时多单页状态快照字段
    finalSelectedLine?: string; // 定格离盘时最终录入的答案快照（行号 / 物理地址 / 复杂度文本）
    unlockedHintIndexes: number[]; // 【黑盒破译专用】当前玩家已花费奖励金币解锁的线索索引数组
    hintCostTotal: number;  // 【黑盒破译专用】解锁线索累计扣除的奖励金币总量
    
    content: string[];      // 玩家的历史输入日志 / 答案提交历史列表
    startAt: Date;          // 游戏开始时间
    finalReward: number;    // 最终奖励
    judgeByAdmin: boolean;  // 人工申诉
}

// 新增：天梯轮次数据模型
export interface LadderRoundDoc {
    _id?: ObjectId;
    name: string;           // 轮次名称，如 "第1周天梯赛"
    stageId: ObjectId;      // 关联的隐藏关卡 ID
    startTime: Date;        // 开始时间
    endTime: Date;          // 结束时间
    isActive: boolean;      // 是否为当前活跃轮次
    limit: number;          // 准入门槛，暂定为 RP
    ticket: number;         // 入场门票定价
    createdAt: Date;
}

declare module 'hydrooj' {
    interface Model {
        stages: typeof StagesModel;
        stages_challenge: typeof StagesChallengeModel;
        stages_ladder_round: typeof LadderRoundModel;
    }
    interface Collections {
        stages: StagesDoc;
        stages_challenge: StagesChallengeDoc;
        stages_ladder_round: LadderRoundDoc;
    }
}

// ========================================================
// 2. 静态配置数据访问器 (StagesModel)
// ========================================================
export class StagesModel {
    static coll = stagesCollection;

    /**
     * A. 根据特定的过滤规则，批量获取原始关卡列表
     */
    static async getMany(filter: Filter<StagesDoc> = {}): Promise<StagesDoc[]> {
        return await stagesCollection.find(filter).sort({ privilege: 1, createdAt: -1 }).toArray();
    }

    /**
     * B. 🌟【核心大厅 AC 绿勾联查雷达】
     * 作用：读取大厅列表时，通过 $lookup 自动把当前学生在每一关的最优战果打包带出，供前端大厅卡片一键渲染“小绿勾”！
     * 🔧【修改】：增加了 status 参数，默认为 0，用于过滤大厅只显示公开关卡。
     */
    static async getWithUserStatus(uid: number, type: number, status: number = 0): Promise<any[]> {
        // 构建 match 条件，现在同时按 type 和 status 过滤
        const matchCondition: any = { type: type };
        if (status !== undefined) {
            matchCondition.status = status;
        } else {
            // 如果未传 status，为了安全起见，可以选择只显示公开关卡 (status: 0)
            // 或者不添加 status 条件（这会返回所有状态的该 type 关卡）
            // 这里选择只显示公开关卡作为默认行为
            matchCondition.status = 0; 
        }
        // 如果 status 为 2 (天梯)，则可能需要移除或修改 status 条件
        // if (status === 2) {
        //     // 如果要获取天梯关卡，则只按 type 过滤，或者明确指定 status: 2
        //     matchCondition.status = 2;
        // }

        return await stagesCollection.aggregate([
            { $match: matchCondition },
            {
                $lookup: {
                    from: 'stages_challenge',
                    let: { stageId: '$_id' },
                    pipeline: [
                        {
                            $match: {
                                $expr: {
                                    $and: [
                                        { $eq: ['$stageId', '$$stageId'] },
                                        { $eq: ['$uid', uid] }
                                    ]
                                }
                            }
                        },
                        { $sort: { status: 1, startAt: -1 } } // 优先将通关成功的(1)排在最上层作为最优战绩快照
                    ],
                    as: 'userChallenges'
                }
            },
            {
                $project: {
                    author: 1, createdAt: 1, privilege: 1, type: 1, status: 1,
                    duration: 1, maxChances: 1, reward: 1, title: 1, problem: 1,
                    codeSnippet: 1, ac: 1, tried: 1, hints: 1, keywords: 1,
                    challengeSnapshot: { $arrayElemAt: ['$userChallenges', 0] }
                }
            },
            { $sort: { privilege: 1, createdAt: -1 } }
        ]).toArray();
    }


    /**
     * C. 精准读取单条静态关卡配置
     */
    static async getOne(id: ObjectId): Promise<StagesDoc | null> {
        return await stagesCollection.findOne({ _id: id });
    }

    /**
     * D. 计数器原子级自增不负 (AC数 / Tried参与挑战数)
     */
    static async incCounter(id: ObjectId, field: 'ac' | 'tried'): Promise<void> {
        const updateDoc: any = {};
        updateDoc[field] = 1;
        await stagesCollection.updateOne({ _id: id }, { $inc: updateDoc });
    }

    /**
     * E. 【高级关卡注入】支持 5 大游戏物料字段录入，100% 初始化 ac / tried
     */
    static async add(
        author: number,
        type: number,
        title: string,
        problem: string,
        codeSnippet: string,
        answer: string,
        analysis: string,
        duration: number,
        maxChances: number,
        reward: number,
        hints: { id: number; text: string; cost: number; status: string; }[] = [],
        keywords: string[] = [],
        privilege: number = 1,
        status: number = 1,
    ): Promise<ObjectId> {
        const doc: StagesDoc = {
            author,
            createdAt: new Date(),
            privilege,
            type,
            status,
            duration: parseInt(duration as any) || 60,
            maxChances: parseInt(maxChances as any) || 3,
            reward: parseInt(reward as any) || 60,
            title: title.trim(),
            problem: problem.trim(),
            codeSnippet: codeSnippet ? codeSnippet : undefined,
            answer: answer.trim(),
            analysis: analysis.trim(),
            hints: Array.isArray(hints) ? hints : [],
            keywords: Array.isArray(keywords) ? keywords.map(k => k.trim()) : [],
            ac: 0,
            tried: 0
        };
        const result = await stagesCollection.insertOne(doc);
        return result.insertedId;
    }

    /**
     * F. 【全量更新】支持对多态及线索字段的合并更新
     */
    static async updateOne(id: ObjectId, updateFields: Partial<StagesDoc>): Promise<boolean> {
        const cleanFields: any = { ...updateFields };
        if (cleanFields.privilege !== undefined) cleanFields.privilege = parseInt(cleanFields.privilege);
        if (cleanFields.type !== undefined) cleanFields.type = parseInt(cleanFields.type);
        if (cleanFields.status !== undefined) cleanFields.status = parseInt(cleanFields.status);
        if (cleanFields.duration !== undefined) cleanFields.duration = parseInt(cleanFields.duration);
        if (cleanFields.maxChances !== undefined) cleanFields.maxChances = parseInt(cleanFields.maxChances);
        if (cleanFields.reward !== undefined) cleanFields.reward = parseInt(cleanFields.reward);
        if (cleanFields.title !== undefined) cleanFields.title = cleanFields.title.trim();
        if (cleanFields.problem !== undefined) cleanFields.problem = cleanFields.problem.trim();
        if (cleanFields.answer !== undefined) cleanFields.answer = cleanFields.answer.trim();
        if (cleanFields.analysis !== undefined) cleanFields.analysis = cleanFields.analysis.trim();
        if (cleanFields.codeSnippet !== undefined) cleanFields.codeSnippet = cleanFields.codeSnippet;
        if (cleanFields.keywords !== undefined) cleanFields.keywords = Array.isArray(cleanFields.keywords) ? cleanFields.keywords.map(k => k.trim()) : [];
        if (cleanFields.hints !== undefined) cleanFields.hints = Array.isArray(cleanFields.hints) ? cleanFields.hints : [];

        const result = await stagesCollection.updateOne(
            { _id: id },
            { $set: cleanFields }
        );
        return result.modifiedCount > 0;
    }
}

// ========================================================
// 3. 玩家动态挑战记录访问器 (StagesChallengeModel)
// ========================================================
export class StagesChallengeModel {
    static coll = challengeCollection;

    static async getOne(filter: Filter<StagesChallengeDoc> = {}): Promise<StagesChallengeDoc | null> {
        return await challengeCollection.findOne(filter);
    }

    static async getActiveOne(uid: number, stageId: ObjectId): Promise<StagesChallengeDoc | null> {
        return await challengeCollection.findOne({ uid, stageId, status: 0 });
    }

    static async getLatestOne(uid: number, stageId: ObjectId): Promise<StagesChallengeDoc | null> {
        return await challengeCollection.findOne({ uid, stageId }, { sort: { startAt: -1 } });
    }

    static async getMany(filter: Filter<StagesChallengeDoc> = {}): Promise<StagesChallengeDoc[]> {
        return await challengeCollection.find(filter).sort({ startAt: -1 }).toArray();
    }

    static async updateProgress(id: ObjectId, updateDoc: any): Promise<boolean> {
        const finalUpdate = updateDoc.$set || updateDoc.$push || updateDoc.$inc ? updateDoc : { $set: updateDoc };
        const result = await challengeCollection.updateOne({ _id: id }, finalUpdate);
        return result.modifiedCount > 0;
    }

    static async updateStatus(id: ObjectId, status: number): Promise<boolean> {
        const result = await challengeCollection.updateOne({ _id: id }, { $set: {status}});
        return result.modifiedCount > 0;
    }

    static async updateJudge(id: ObjectId, judgeByAdmin: boolean): Promise<boolean> {
        const result = await challengeCollection.updateOne({ _id: id }, { $set: {judgeByAdmin}});
        return result.modifiedCount > 0;
    }

    /**
     * F. 🔒【线索解锁金币扣减机制】黑盒破译小游戏专用
     * 作用：原子化扣减预计金币奖励，并将解锁线索索引同步回数据库
     */
    static async unlockHint(id: ObjectId, hintIndex: number, cost: number): Promise<boolean> {
        const result = await challengeCollection.updateOne(
            { _id: id },
            {
                $push: { unlockedHintIndexes: hintIndex, content: `[HINT_UNLOCK] 花费了 ${cost} 奖励金币解锁了第 ${hintIndex + 1} 条隐藏线索` as any },
                $inc: { hintCostTotal: cost }
            }
        );
        return result.modifiedCount > 0;
    }
}

// ========================================================
// 4. 天梯轮次管理模型 (LadderRoundModel)
// ========================================================
export class LadderRoundModel {
    static coll = ladderRoundCollection;

    // 获取当前活跃的天梯轮次
    static async getCurrentRound(): Promise<LadderRoundDoc | null> {
        return await ladderRoundCollection.findOne({ isActive: true });
    }

    // 获取指定时间段内的轮次（用于查找即将开始或正在结束的轮次）
    static async getRoundsByTimeRange(start: Date, end: Date): Promise<LadderRoundDoc[]> {
        return await ladderRoundCollection.find({
            $and: [
                { startTime: { $lte: end } },
                { endTime: { $gte: start } }
            ]
        }).toArray();
    }

    // 创建新轮次
    static async createRound(name: string, stageId: ObjectId, startTime: Date, endTime: Date, limit: number, ticket: number): Promise<ObjectId> {
        const round: LadderRoundDoc = {
            name,
            stageId,
            startTime,
            endTime,
            isActive: true,
            limit: limit,
            ticket: ticket,
            createdAt: new Date()
        };
        const result = await ladderRoundCollection.insertOne(round);
        return result.insertedId;
    }

    // 设置轮次为非活跃状态
    static async setInactive(roundId: ObjectId): Promise<boolean> {
        const result = await ladderRoundCollection.updateOne(
            { _id: roundId },
            { $set: { isActive: false } }
        );
        return result.modifiedCount > 0;
    }

    // 增加参与人数
    static async incParticipants(roundId: ObjectId): Promise<void> {
        await ladderRoundCollection.updateOne(
            { _id: roundId },
            { $inc: { participants: 1 } }
        );
    }
}