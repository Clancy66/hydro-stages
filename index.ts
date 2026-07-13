import { Handler, ObjectId, PRIV, ForbiddenError, BadRequestError, NotFoundError, param, Types, db, moment, fs } from 'hydrooj';
import { StagesModel, StagesChallengeModel } from './models';

// 5 大竞赛关卡局部子模板映射注册中心
const TYPE_MAP: Record<number, string> = {
    0: 'partials/blackbox.html',     // 🔎 黑盒破译
    1: 'partials/findbug.html',      // 🔍 代码找茬
    2: 'partials/puzzle.html',       // 🧩 代码拼图
    3: 'partials/memory.html',       // 💾 内存劫变
    4: 'partials/complexity.html'    // ⏱️ 时空刺客
};

function toNumber(v: any, def = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
}

function normalizeHints(hints: any[] = []) {
    return hints.map((h, idx) => {
        // 如果已经是对象（兼容旧数据）
        if (typeof h === 'object' && h !== null) {
            return {
                id: Number(h.id ?? idx),
                text: String(h.text ?? ''),
                cost: Number(h.cost ?? 0),
                status: String(h.status ?? 'normal')
            };
        }

        // 如果是 string（你现在的情况）
        return {
            id: idx,
            text: String(h),
            cost: 0,
            status: 'normal'
        };
    });
}

/**
 * ========================================================
 * 1. 主要游戏逻辑处理器
 * ========================================================
 */
class StagesHandler extends Handler {
    static methods = ['GET', 'POST'];

    async get() {
        if (!this.user.hasPriv(PRIV.PRIV_USER_PROFILE)) {
            throw new ForbiddenError('你在此域中无相应权限');
        }

        const stageIdStr = this.request.query.stageId;

        // 路径 A：URL 未携带题目 ID -> 驱动并渲染【游戏大厅主页】
        if (!stageIdStr) {
            const currentType = this.request.query.type ? parseInt(this.request.query.type as string) : 0;
            
            // 【天梯对抗赛专用逻辑分支】当点击第 6 个选项卡"天梯对抗 (type=5)"时
            if (currentType === 5) {
                const timeNow = new Date();
                // ============================
                // 处理过期轮次，公开关联关卡，这个应该挂在钩子上，我懒
                // ============================
                // 1. 首先查找需要更新的轮次及其关卡ID
                const expiredRounds = await db.collection('stages_ladder_round').find({
                    endTime: { $lt: timeNow }
                }).toArray();

                // 2. 提取关卡ID数组
                const stageIds = expiredRounds.map(round => round.stageId);

                // 3. 更新轮次表
                if (stageIds.length > 0) {
                    await db.collection('stages_ladder_round').updateMany(
                        { 
                            isActive: true,
                            endTime: { $lt: timeNow }
                        },
                        { 
                            $set: { isActive: false } 
                        }
                    );

                    // 如果要添加天梯赛额外奖励，可在此处进行金币奖励的实现

                    // 4. 更新关卡表（仅更新过期轮次绑定的关卡）
                    await db.collection('stages').updateMany(
                        { 
                            _id: { $in: stageIds },  // 匹配查找到的关卡ID
                            status: { $ne: 0 }       // 只更新非0状态的关卡（可选优化）
                        },
                        { 
                            $set: { status: 0 } 
                        }
                    );
                }

                // 从数据库获取当前活跃的天梯轮次
                let activeRound = await db.collection('stages_ladder_round').findOne({ isActive: true });
                let ladderStage = null;
                let ladderChallenge = null;
                let ladderLeaderboard: any[] = [];
                let startTime = null;
                let endTime = null;

                // 如果当前没有活跃天梯赛，则将最早的一个置为活跃
                if (!activeRound) {
                    const firstRound = await db.collection('stages_ladder_round').find({ 
                            endTime: { $gt: timeNow }
                        })
                        .sort({ startTime: 1 })
                        .limit(1)
                        .next();

                    if (firstRound) {
                        await db.collection('stages_ladder_round').updateOne(
                            {_id: firstRound._id },
                            { $set: { isActive: true } }
                        )
                        activeRound = await db.collection('stages_ladder_round').findOne({ isActive: true });
                    }
                }

                if (activeRound) {
                    startTime = moment(activeRound.startTime).format("YYYY-MM-DD HH:mm");
                    endTime = moment(activeRound.endTime).format("YYYY-MM-DD HH:mm");
                    // 根据轮次关联的关卡 ID 获取关卡详情
                    ladderStage = await StagesModel.getOne(activeRound.stageId);
                    if (ladderStage) {
                        // 检查当前用户是否已解锁该天梯赛
                        ladderChallenge = await StagesChallengeModel.coll.findOne({
                            uid: this.user._id,
                            stageId: new ObjectId(ladderStage._id)
                        });

                        // 获取排行榜（假设 status: 1 表示已完成）
                        ladderLeaderboard = await db.collection('stages_challenge').aggregate([
                            { $match: { stageId: new ObjectId(ladderStage._id), status: 1 } },
                            { $sort: { timeUsed: 1, chancesUsed: 1, startAt: 1 } }, // 按时间、次数、开始时间排序
                            { $limit: 10 },
                            {
                                $lookup: {
                                    from: 'user',
                                    localField: 'uid',
                                    foreignField: '_id',
                                    as: 'playerInfo'
                                }
                            },
                            {
                                $project: {
                                    timeUsed: 1, chancesUsed: 1, startAt: 1,
                                    playerName: { $arrayElemAt: ['$playerInfo.uname', 0] } // 只取用户名
                                }
                            }
                        ]).toArray();
                    }
                }

                this.response.body = {
                    ...this.response.body,
                    currentType, ladderStage, ladderChallenge, ladderLeaderboard,
                    activeRound, // 将轮次信息也传递给前端，用于显示轮次名称等
                    startTime, endTime,
                    feedbackMsg: this.request.query.feedbackMsg || null
                };
                this.response.template = 'stages_main.html';
                return;
            }

            // 🟢 普通 0-4 种基础题型的普通大厅联查流
            // 🔧 修改：只获取 status 为 0 (公开) 的关卡
            const stageList = await StagesModel.getWithUserStatus(this.user._id, currentType, 0); // 传递 status: 0

            this.response.body = { ...this.response.body, stageList, currentType, feedbackMsg: this.request.query.feedbackMsg || null };
            this.response.template = 'stages_main.html';
            return;
        }

        // 🔴 路径 B：URL 携带题目 ID -> 驱动并进入【具体游戏关卡对局现场】
        const stageId = new ObjectId(stageIdStr as string);
        const stage = await StagesModel.getOne(stageId);

        if (!stage) throw new NotFoundError('该竞技内容不存在');
        
        // 检查天梯赛权限
        if (stage.status === 2) {
            const activeRound = await db.collection('stages_ladder_round').findOne({ isActive: true });
            const timeNow = new Date();
            
            if (!activeRound) {
                throw new ForbiddenError('当前没有活跃状态的天梯赛！');
            }
            if (activeRound.startTime > timeNow) {
                throw new ForbiddenError('本轮天梯赛暂未开始，请耐心等待！');
            }
            if (this.user.rp < activeRound.limit) {
                throw new ForbiddenError('天梯对抗赛属于高级对抗。你当前域内 RP 积分不足 ' + activeRound.limit + ' 积分，暂不满足准入门槛！');
            }
            
            if (this.user.coin < activeRound.ticket) {
                throw new ForbiddenError('你的金币数量不足 ' + activeRound.ticket + '，无法解锁本轮天梯对抗赛！');
            }
            // 这里先不扣除门票
        } else if (stage.status === 1) {
            throw new NotFoundError('该关卡已被禁用');
        }

        // ==========================================
        // ⚡【GET 单页指令劫持：解锁黑盒隐藏线索】
        // ==========================================
        const unlockHintIndexStr = this.request.query.unlockHint;

        if (unlockHintIndexStr !== undefined) {
            this.response.type = 'json';
            const activeChallenge = await StagesChallengeModel.getActiveOne(this.user._id, stageId);
            if (!activeChallenge) return this.response.body = { success: false, msg: '战局非活跃！' };

            const hintIndex = parseInt(unlockHintIndexStr as string) - 1;
            const targetHint = stage.hints && stage.hints[hintIndex];
            if (!targetHint) return this.response.body = { success: false, msg: '无此线索' };

            if (activeChallenge.unlockedHintIndexes && activeChallenge.unlockedHintIndexes.includes(hintIndex)) {
                return this.response.body = { success: true, msg: '已解锁过' };
            }

            await StagesChallengeModel.unlockHint(activeChallenge._id, hintIndex, targetHint.cost);
            this.response.body = { success: true, msg: '成功解锁', cost: targetHint.cost, activeChallenge };
            return;
        }
        // ==========================================
        // ⏰【后端对局绝对时间自愈结算审计层与防刷新断档】
        // ==========================================
        let activeChallenge = await StagesChallengeModel.getActiveOne(this.user._id, stageId);
        let historyChallenge = null;

        if (activeChallenge) {
            const now = new Date();
            const timeUsed = Math.floor((now.getTime() - activeChallenge.startAt.getTime()) / 1000);
            
            if (timeUsed >= stage.duration) {
                await StagesChallengeModel.updateProgress(activeChallenge._id, {
                    $set: { status: 3, timeUsed: stage.duration, finalSelectedLine: "暂无" },
                    $push: { content: `[GET_TIMEOUT] 计时期满，后端执行超时判定落盘。` }
                });
                historyChallenge = await StagesChallengeModel.getOne(activeChallenge._id);
                activeChallenge = null;
            } else {
                (activeChallenge as any).timeLeft = stage.duration - timeUsed;
            }
        } else {
            historyChallenge = await StagesChallengeModel.getLatestOne(this.user._id, stageId);
        }

        const clientStage = { ...stage, _id: stage._id.toHexString() };
        let finalDisplayLine = "暂无";
        let finalDisplayReward = 0;

        // 补齐历史完赛归档的对比状态数组 [1, 2, 3]，彻底驱散 Expression expected 编译盲区
        if (historyChallenge && [1, 2, 3].indexOf(historyChallenge.status) !== -1) {
            activeChallenge = null; 
            finalDisplayLine = historyChallenge.finalSelectedLine || "暂无";

            if (historyChallenge.status === 1) {
                // 可以考虑随着时间长短减少奖励
                // const tenPercentTime = Math.floor(stage.duration / 10) || 1;
                // const tenPercentReward = Math.floor(stage.reward / 10) || 1;
                // const deduction = Math.floor(historyChallenge.timeUsed / tenPercentTime) * tenPercentReward;
                
                const basicReward = Math.max(0, (stage.reward || 60));
                const hintCost = historyChallenge.hintCostTotal || 0;
                finalDisplayReward = Math.max(0, basicReward - hintCost);
            } else {
                finalDisplayReward = 0;
            }
        } else if (!activeChallenge) {
            delete (clientStage as any).analysis;
        }

        delete (clientStage as any).answer;
        const feedbackMsg = this.request.query.feedbackMsg || null;

        this.response.body = { 
            stage: clientStage, activeChallenge, historyChallenge, feedbackMsg, finalDisplayLine, finalDisplayReward
        };
        
        this.response.template = TYPE_MAP[stage.type];
    }

    async post() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
    }

    // 开始闯关
    @param('stageId', Types.ObjectId)
    async postCreate(args: any, stageId: ObjectId) {
        if (!this.user.hasPriv(PRIV.PRIV_USER_PROFILE)) {
            throw new ForbiddenError('发布指令遭拒：你没有权限！');
        }
        if (!stageId) throw new BadRequestError('参数缺失: stageId');
        const stage = await StagesModel.getOne(stageId);
        if (!stage || stage.status === 1) throw new NotFoundError('该竞技内容不可用');

        // 🟢 普通关卡的常规开局原子落盘逻辑
        const hasActive = await StagesChallengeModel.getActiveOne(this.user._id, stageId);
        if (!hasActive) {
            if (stage.status === 2) {
                // 正式扣除门票
                const activeRound = await db.collection('stages_ladder_round').findOne({ isActive: true });

                // 依赖于金币插件
                const currentLog = "[购买天梯赛入场券] " + activeRound.name;
                await db.collection('bills').insertOne({
                    createAt: new Date(),
                    rootId: this.user._id,
                    uid: this.user._id,
                    goodsId: "",
                    coins: -activeRound.ticket,
                    content: currentLog,
                    check: 2
                });
                await db.collection('coins').findOneAndUpdate(
                    { uid: this.user._id },
                    { $inc: { total: -activeRound.ticket } },
                    { upsert: true }
                );
            }
            await StagesChallengeModel.coll.insertOne({
                uid: this.user._id,
                stageId: stageId,
                timeUsed: 0,
                chancesUsed: 0,
                status: 0, 
                unlockedHintIndexes: [0,], 
                hintCostTotal: 0,        
                content: [],
                startAt: new Date(),
                finalReward: 0
            });
            await StagesModel.incCounter(stageId, 'tried');
        }
        this.response.redirect = `/stages?stageId=${stageId.toHexString()}`;
    }

    // 提交答案
    @param('stageId', Types.ObjectId)
    async postSubmit(args: any, stageId: ObjectId) {
        if (!this.user.hasPriv(PRIV.PRIV_USER_PROFILE)) {
            throw new ForbiddenError('发布指令遭拒：你没有权限！');
        }
        if (!stageId) throw new BadRequestError('参数缺失: stageId');
        const stage = await StagesModel.getOne(stageId);
        if (!stage) throw new NotFoundError('关卡配置丢失');

        const challenge = await StagesChallengeModel.getActiveOne(this.user._id, stageId);
        if (!challenge) {
            this.response.redirect = `/stages?stageId=${stageId.toHexString()}&feedbackMsg=未找到正在进行的活跃挑战，或当前战局已超时结算！`;
            return;
        }

        let userInput = "";
        let isCorrect = false;

        // 🎭 5 大子游戏核心开火裁决算法
        if (stage.type === 0) {
            // 🔎 Type 0：黑盒破译 —— 关键字列表多对一模糊包含比对
            userInput = String(this.request.body?.userInput || "").trim();
            if (!userInput) {
                this.response.redirect = `/stages?stageId=${stageId.toHexString()}&feedbackMsg=黑盒破译输入框不能为空！`;
                return;
            }
            const keywordsPool = stage.keywords || [];
            isCorrect = keywordsPool.some(kw => userInput.toLowerCase().includes(String(kw).toLowerCase()));
        } else {
            // 🔍 Type 1, 2, 3, 4：代码找茬、代码拼图、内存劫变、时空刺客
            userInput = String(this.request.body?.selectedLine || "").trim();
            if (!userInput) {
                this.response.redirect = `/stages?stageId=${stageId.toHexString()}&feedbackMsg=请先在答题区选择目标后再点击提交。`;
                return;
            }

            isCorrect = userInput.toLowerCase() === stage.answer.toLowerCase();
        }

        const now = new Date();
        const absoluteTimeUsed = Math.floor((now.getTime() - challenge.startAt.getTime()) / 1000);
        
        if (absoluteTimeUsed > stage.duration) {
            await StagesChallengeModel.updateProgress(challenge._id, {
                $set: { status: 3, timeUsed: stage.duration, finalSelectedLine: userInput },
                $push: { content: `[TIMEOUT] 战局超时，自动提交。` }
            });
            this.response.redirect = `/stages?stageId=${stageId.toHexString()}`;
            return;
        }

        const nextChancesUsed = challenge.chancesUsed + 1;
        const remainingChances = Math.max(0, stage.maxChances - nextChancesUsed);
        const currentLog = `提交答案录入: [${userInput}]`;

        if (isCorrect) {
            const basicReward = Math.max(0, (stage.reward || 60));
            const hintCost = challenge.hintCostTotal || 0;
            const finalReward = Math.max(0, basicReward - hintCost);

            // 更新金币账单，依赖金币插件
            await db.collection('coins').findOneAndUpdate(
                { uid: this.user._id },
                { $inc: { total: finalReward, stages: finalReward } },
                { upsert: true }
            );

            // 🎉 成功通关 (status: 1)
            await StagesChallengeModel.updateProgress(challenge._id, {
                $set: { status: 1, timeUsed: absoluteTimeUsed, chancesUsed: nextChancesUsed, finalSelectedLine: userInput, finalReward: finalReward },
                $push: { content: `${currentLog} (通过)` }
            });
            await StagesModel.incCounter(stageId, 'ac');
            
            this.response.redirect = `/stages?stageId=${stageId.toHexString()}&feedbackMsg=🎉 恭喜通关，斩获大奖！`;
        } else {
            if (remainingChances <= 0) {
                // 次数用尽战败 (status: 2)
                await StagesChallengeModel.updateProgress(challenge._id, {
                    $set: { status: 2, timeUsed: absoluteTimeUsed, chancesUsed: nextChancesUsed, finalSelectedLine: userInput, finalReward: 0 },
                    $push: { content: `${currentLog} (机会耗尽)` }
                });
                
                if (stage.status === 2) {
                    this.response.redirect = `/stages?type=5&feedbackMsg=❌ 机会用尽！`;
                    return;
                }
                
                this.response.redirect = `/stages?stageId=${stageId.toHexString()}`;
            } else {
                await StagesChallengeModel.updateProgress(challenge._id, {
                    $set: { chancesUsed: nextChancesUsed },
                    $push: { content: `${currentLog} (不正确)` }
                });
                
                let wrongMsg = "";
                if (stage.type === 0) wrongMsg = `口令未击中，请继续破译！`;
                else if (stage.type === 2) wrongMsg = `结果不正确，请重新排序！`;
                else wrongMsg = `结果不正确，请重新排查！`;
                this.response.redirect = `/stages?stageId=${stageId.toHexString()}&feedbackMsg=⚠️ ${wrongMsg}`;
            }
        }
    }

    // 管理员下架关卡接口
    @param('stageId', Types.ObjectId)
    async postDisableStage(args: any, stageId: ObjectId) {
        if (!this.user.hasPriv(PRIV.PRIV_SET_PERM)) {
            throw new ForbiddenError('高级管理权限拒绝');
        }
        if (!stageId) throw new BadRequestError('参数缺失');

        const stage = await StagesModel.getOne(new ObjectId(stageId));
        if (!stage) throw new NotFoundError('该题目不存在');

        const challenge = await StagesChallengeModel.getActiveOne(this.user._id, new ObjectId(stageId));
        if (challenge) throw new NotFoundError('当前有人正在挑战，请稍后再试');

        // 更新关卡状态为 1 (禁用)
        await StagesModel.updateOne(new ObjectId(stageId), { status: 1 });

        // 重定向回原类型页面
        this.response.redirect = `/stages?type=${stage.type}`;
    }
}

/**
 * ========================================================
 * 2. 管理员后台处理器
 * ========================================================
 */
class StagesManageHandler extends Handler {
    static methods = ['GET', 'POST'];

    async get() {
        if (!this.user.hasPriv(PRIV.PRIV_SET_PERM)) {
            throw new ForbiddenError('权限不足：只有系统级或域管理员可访问天梯轮次管理！');
        }

        // 获取禁用关卡
        const banStages = await StagesModel.getMany({status: 1});
        // 获取公开关卡
        const pubStages = await StagesModel.getMany({status: 0});

        // 获取所有轮次（按时间倒序）
        const rounds = await db.collection('stages_ladder_round').find().sort({ createdAt: -1 }).toArray();
        
        // ✅ 关键：预加载关卡标题映射表（避免 N+1 查询）
        const challengeIds = rounds.map(r => new ObjectId(r.stageId));
        const stageMapObj: Record<string, { title: string; _id: string, tried: number }> = {};

        if (challengeIds.length > 0) {
            const stages = await StagesModel.getMany({ _id: { $in: challengeIds } });
            stages.forEach(stage => {
                stageMapObj[stage._id.toHexString()] = { 
                    title: stage.title || '未知关卡', 
                    _id: stage._id.toHexString(),
                    tried: stage.tried
                };
            });
        }

        // 获取所有隐藏关卡（用于选择）
        const ladderStages = await StagesModel.getMany({ status: 2 });

        // 修改关卡信息，这里返回当前关卡信息
        const stageIdStr = this.request.query.stageId;
        if (stageIdStr) {
            const stageId = new ObjectId(stageIdStr as string);
            const stage = await StagesModel.getOne(stageId);

            if (!stage) throw new NotFoundError('该竞技内容不存在');

            this.response.body = {
                stage
            }
        }

        this.response.body = {
            ...this.response.body,
            banStages,
            pubStages,
            rounds,
            ladderStages,
            stageMap: stageMapObj, // 👈 这里是普通对象！
            _csrf: this.context._csrf || ""
        };
        this.response.template = 'manager.html';
    }

    async post(args: any) {
        if (!this.user.hasPriv(PRIV.PRIV_SET_PERM)) {
            throw new ForbiddenError('发布指令遭拒：您非本域高级管理人员！');
        }
    }

    // 创建天梯赛
    async postCreateRound(args: any) {
        if (!this.user.hasPriv(PRIV.PRIV_SET_PERM)) {
            throw new ForbiddenError('发布指令遭拒：您非本域高级管理人员！');
        }

        const { name, challengeId, startTime, endTime, limit, ticket } = args;

        if (!name || !challengeId || !startTime || !endTime || !limit) {
            throw new BadRequestError('参数缺失：请填写所有必填项！');
        }

        const startDateTime = new Date(startTime);
        const endDateTime = new Date(endTime);

        if (isNaN(startDateTime.getTime()) || isNaN(endDateTime.getTime())) {
            throw new BadRequestError('日期格式错误！');
        }

        if (startDateTime >= endDateTime) {
            throw new BadRequestError('结束时间必须晚于开始时间！');
        }

        // 验证关卡
        const challenge = await StagesModel.getOne(new ObjectId(challengeId));
        if (!challenge || challenge.status !== 2) {
            throw new BadRequestError('所选关卡不存在或不是隐藏状态！');
        }

        const ladder = await db.collection('stages_ladder_round').findOne({stageId: challenge._id});
        if (ladder) {
            throw new BadRequestError('所选关卡已入选其它轮次！');
        }

        // 检查时间冲突
        const conflictCount = await db.collection('stages_ladder_round').countDocuments({
            $and: [
                { startTime: { $lt: endDateTime } },
                { endTime: { $gt: startDateTime } }
            ]
        });

        if (conflictCount > 0) {
            throw new BadRequestError('所选时间与其他活跃轮次冲突！');
        }

        const newRound = {
            name,
            stageId: new ObjectId(challengeId),
            startTime: startDateTime,
            endTime: endDateTime,
            isActive: false,    // 默认置为 flase，在 get 方法中选取时间最早的置为活跃
            limit: Number(limit),
            ticket: Number(ticket),
            createdAt: new Date()
        };

        await db.collection('stages_ladder_round').insertOne(newRound);

        this.response.redirect = '/stages/manage?feedbackMsg=天梯轮次创建成功！';
    }

    // 删除天梯赛
    async postDeleteRound(args: any) {
        if (!this.user.hasPriv(PRIV.PRIV_SET_PERM)) {
            throw new ForbiddenError('发布指令遭拒：您非本域高级管理人员！');
        }

        const { roundId } = args;

        if (!roundId) {
            throw new BadRequestError('参数缺失：缺少轮次ID！');
        }

        const ladder = await db.collection('stages_ladder_round').findOne({_id: new ObjectId(roundId)});

        const challenge = await StagesChallengeModel.getActiveOne(this.user._id, ladder.stageId);
        if (challenge) throw new NotFoundError('当前有人正在挑战，请稍后再试');

        await db.collection('stages_ladder_round').deleteOne(
            { _id: new ObjectId(roundId) }
        );

        this.response.redirect = '/stages/manage?feedbackMsg=天梯轮次已成功结束！';
    }

    // 创建关卡
    async postCreateStage(args: any) {
        if (!this.user.hasPriv(PRIV.PRIV_SET_PERM)) {
            throw new ForbiddenError('发布指令遭拒：您非本域高级管理人员！');
        }

        const { stageId, type, title, problem, answer, analysis, duration, maxChances, reward, status, privilege, keywordsRaw, hintsRaw, codeSnippet } = args;

        if (!title) {
            throw new BadRequestError('参数缺失：关卡名称和问题描述不可为空！');
        }

        // 🎯 修复 Bug 1：处理 type 等于 0 的边界逻辑。不能直接使用 type || 1
        const finalType = (type !== undefined && type !== null) ? Number(type) : 1;
        const finalDuration = Number(duration) || 60;
        const finalMaxChances = Number(maxChances) || 3;
        const finalReward = Number(reward) || 60;
        const finalPrivilege = Number(privilege) || 1;

        // 🎯 修复 Bug 3：深度破译并处理黑盒专属的高阶物料
        let keywordsArray: string[] = [];
        if (keywordsRaw && keywordsRaw.trim() !== "") {
            keywordsArray = keywordsRaw.split(',').map((k: string) => k.trim()).filter(Boolean);
        }

        let hintsArray: { id: number; text: string; cost: number; status: string }[] = [];
        if (hintsRaw && hintsRaw.trim() !== "") {
            try {
                hintsArray = JSON.parse(hintsRaw);
            } catch (e) {
                // 如果管理员不小心写错了 JSON，提供默认兜底
                hintsArray = [{ id: 1, text: "（线索包解析失败，请检查管理后台 JSON 语法）", cost: 0, status: "" }];
            }
        }

        if (stageId !== "" && stageId !== undefined) {
            await StagesModel.updateOne(new ObjectId(stageId),
                {
                    privilege: finalPrivilege,
                    type: finalType,
                    status: Number(status),
                    duration: finalDuration,
                    maxChances: finalMaxChances,
                    reward: finalReward,
                    title,
                    problem,
                    answer,
                    analysis,
                    codeSnippet,
                    keywords: keywordsArray,
                    hints: hintsArray
                }
            );
        }
        else {
            // 🚀 终极一击落盘：全量参数 100% 对应存入 MongoDB 静态配置集合
            await StagesModel.add(
                this.user._id,
                finalType,       // 0 会被稳稳当当地作为整数 0 存入！
                title,
                problem,
                codeSnippet,
                answer || "黑盒多关键字自动包含匹配",
                analysis || "",
                finalDuration,
                finalMaxChances,
                finalReward,
                hintsArray,      // 完美的 JSON 对象数组结构落盘
                keywordsArray,   // 包含分隔后的关键字数组落盘
                finalPrivilege,
                Number(status)
            );    
        }

        // 重定向带参数退回大厅
        const targetType = status === 2 ? "5" : String(finalType);
        this.response.redirect = `/stages?type=${targetType}&feedbackMsg=🎉 恭喜！全新的竞技对抗关卡任务已【100%成功入库并发布】！`;
    }

    // 禁用关卡
    async postDisableStage(args: any) {
        const { stageId } = args;
        if (!this.user.hasPriv(PRIV.PRIV_SET_PERM)) {
            throw new ForbiddenError('高级管理权限拒绝');
        }
        if (!stageId) throw new BadRequestError('参数缺失');

        const stage = await StagesModel.getOne(new ObjectId(stageId));
        if (!stage) throw new NotFoundError('该题目不存在');

        const challenge = await StagesChallengeModel.getActiveOne(this.user._id, new ObjectId(stageId));
        if (challenge) throw new NotFoundError('当前有人正在挑战，请稍后再试');

        // 更新关卡状态为 1 (禁用)
        await StagesModel.updateOne(new ObjectId(stageId), { status: 1 });

        // 重定向回原类型页面
        this.response.redirect = `/stages/manage`;
    }

    // 隐藏关卡
    async postHiddenStage(args: any) {
        const { stageId } = args;
        if (!this.user.hasPriv(PRIV.PRIV_SET_PERM)) {
            throw new ForbiddenError('高级管理权限拒绝');
        }
        if (!stageId) throw new BadRequestError('参数缺失');

        const stage = await StagesModel.getOne(new ObjectId(stageId));
        if (!stage) throw new NotFoundError('该题目不存在');

        const challenge = await StagesChallengeModel.getActiveOne(this.user._id, new ObjectId(stageId));
        if (challenge) throw new NotFoundError('当前有人正在挑战，请稍后再试');

        await StagesModel.updateOne(new ObjectId(stageId), { status: 2 });

        // 重定向回原类型页面
        this.response.redirect = `/stages/manage`;
    }

    // 公开关卡
    async postPublicStage(args: any) {
        const { stageId } = args;
        if (!this.user.hasPriv(PRIV.PRIV_SET_PERM)) {
            throw new ForbiddenError('高级管理权限拒绝');
        }
        if (!stageId) throw new BadRequestError('参数缺失');

        const stage = await StagesModel.getOne(new ObjectId(stageId));
        if (!stage) throw new NotFoundError('该题目不存在');

        // 更新关卡状态为 0
        await StagesModel.updateOne(new ObjectId(stageId), { status: 0 });

        // 重定向回原类型页面
        this.response.redirect = `/stages/manage`;
    }

    // 删除关卡（仅在禁用列表可用）
    async postDeleteStage(args: any) {
        const { stageId } = args;
        if (!this.user.hasPriv(PRIV.PRIV_SET_PERM)) {
            throw new ForbiddenError('高级管理权限拒绝');
        }
        if (!stageId) throw new BadRequestError('参数缺失');
        
        const stage = await StagesModel.getOne(new ObjectId(stageId));
        if (!stage) throw new NotFoundError('该题目不存在');

        const challenge = await StagesChallengeModel.getActiveOne(this.user._id, new ObjectId(stageId));
        if (challenge) throw new NotFoundError('当前有人正在挑战，请稍后再试');

        await Promise.all([
            StagesModel.coll.deleteOne({ _id: new ObjectId(stageId) }),
            StagesChallengeModel.coll.deleteMany({ stageId: new ObjectId(stageId) })
        ]);

        this.response.redirect = `/stages/manage`;
    }

    // 导出所有关卡数据
    async postExportStages() {
        if (!this.user.hasPriv(PRIV.PRIV_SET_PERM)) {
            throw new ForbiddenError('高级管理权限拒绝');
        }

        const stages = await StagesModel.getMany({});
        
        // 将 ObjectId 转换为字符串以便 JSON 序列化
        const serializableStages = stages.map(stage => ({
            ...stage,
            _id: stage._id.toString(),
            author: stage.author.toString(), 
        }));

        const jsonData = JSON.stringify(serializableStages, null, 2);
        const filename = `stages_export_${stages.length}_items_${moment().tz('Asia/Shanghai').format("YYYY-MM-DD")}.json`;

        this.response.body = jsonData;
        this.response.type = 'application/json';
        
        // ✅ 修正点：直接操作 ctx.res 设置 Header
        this.response.addHeader('Content-Disposition', `attachment; filename="${filename}"`);
    }

    // 导入关卡数据
    async postImportStages() {
        if (!this.user.hasPriv(PRIV.PRIV_SET_PERM)) {
            throw new ForbiddenError('高级管理权限拒绝');
        }

        const file = this.request.files?.file; 
        
        if (!file) {
            throw new BadRequestError('请选择要上传的 JSON 文件');
        }

        // ✅ 修复点 2：使用 originalFilename 检查后缀
        if (typeof file.originalFilename === 'string') {
            if (!file.originalFilename.toLowerCase().endsWith('.json')) {
                throw new BadRequestError('文件类型错误，请上传 JSON 文件');
            }
        } else {
             throw new BadRequestError('无法确定上传文件的类型');
        }

        const fileContent = await fs.readFile(file.filepath, 'utf-8');
        const importData = JSON.parse(fileContent);

        if (!Array.isArray(importData)) {
            throw new BadRequestError('JSON 格式错误：根节点必须是数组');
        }

        let index = 0;
        const report = {
            total: importData.length,
            success: 0,
            failed: 0,
            errors: [] as {
                index: number;
                message: string;
                data?: any;
            }[]
        };

        for (const stageData of importData) {
            index++;

            try {
                if (!stageData || typeof stageData !== 'object') {
                    throw new Error(`第 ${index} 条数据不是对象`);
                }

                const {
                    _id,
                    title,
                    problem,
                    answer,
                    type,
                    status,
                    privilege,
                    duration,
                    reward,
                    maxChances,
                    analysis,
                    hints,
                    keywords,
                    createdAt,
                    author,
                    codeSnippet
                } = stageData;

                // ===== 必填字段校验 =====
                if (type === undefined) throw new Error(`第 ${index} 条缺少 type`);
                if (title === undefined) throw new Error(`第 ${index} 条缺少 title`);
                if (answer === undefined) throw new Error(`第 ${index} 条缺少 answer`);
                if (analysis === undefined) throw new Error(`第 ${index} 条缺少 analysis`);

                const doc = {
                    title: String(title),
                    problem: String(problem),
                    answer: String(answer),

                    type: toNumber(type),
                    status: 1,
                    privilege: toNumber(privilege, 1),
                    duration: toNumber(duration, 60),
                    reward: toNumber(reward, 0),
                    maxChances: toNumber(maxChances, 1),

                    analysis: analysis ? String(analysis) : '',
                    codeSnippet: codeSnippet ? String(codeSnippet) : '',

                    hints: normalizeHints(hints),
                    keywords: keywords,

                    author: author ? Number(author) : this.user._id,

                    createdAt: new Date(),

                    ac: 0,
                    tried: 0
                };

                await StagesModel.coll.insertOne(doc);
                report.success++;
            } catch (err: any) {
                report.failed++;
                report.errors.push({
                    index: index,
                    message: err.message,
                    data: stageData
                });
            }
        }

        this.response.body = {
            success: true,
            report
        };
    }
}


/**
 * ========================================================
 * 3. 🏆【全局路由双向放行挂载注册中心】
 * ========================================================
 */
export function apply(ctx: any) {
    ctx.Route('stages_main_route', '/stages', StagesHandler);
    ctx.Route('stages_manager_route', '/stages/manage', StagesManageHandler);

    ctx.injectUI('UserDropdown', 'stages_main_route', { icon: 'web', displayName: '编程竞技' }, PRIV.PRIV_USER_PROFILE);
}