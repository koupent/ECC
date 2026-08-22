---
description: マージ済みDeliveryの後に、同じユーザータスクの次のDeliveryを決定論的に開始します。
---

# Delivery Next

前のDeliveryがマージ済みで、ユーザー要求に未完了の工程がある場合だけ使います。

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/codex/delivery-continuation.js" continue "次に完了する具体的なDelivery"
```

時間経過による再試行や曖昧な「続ける」は禁止です。同じユーザータスクでは最大12 Deliveryです。
