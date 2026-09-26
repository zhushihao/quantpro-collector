## 状态读写
只用获准的{{STATE_CHANNEL}}。先read_state_snapshot(symbols=相关标的,include=["{{STATE_CHANNEL}}"],history_limit=10)，按最新有效事件/evidence keys/历史去重继承，跨持仓版本先核身份；MARKET另传trading_date及语义scheduled_slot。
满足入账条件才validate_state_batch(channel="{{STATE_CHANNEL}}",batch=候选)，VALID后append_state_batch传同channel、完全相同batch。仅PERSISTED/IDEMPOTENT_REPLAY后查询get_state_write_receipt(channel="{{STATE_CHANNEL}}",write_key=稳定键)，核对状态/hash/comment id，再同参数read_state_snapshot回读内容一致才算落账。
同键异内容、缺回执、FAILED/CONFLICT/OUTCOME_UNKNOWN或回读不一致不算成功，禁止覆盖/改键重投/换运输。重试原样重放；事实按内容去重，不按事件名。落账不等于通知。
