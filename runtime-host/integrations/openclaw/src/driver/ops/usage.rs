use super::*;

impl ::usage::UsageOps for OpenClawDriver {
    fn usage_recent<'a>(
        &'a self,
        limit: usize,
    ) -> ::usage::ports::UsageFuture<'a, Result<Vec<::usage::UsageEntry>, ::usage::UsageReadError>>
    {
        Box::pin(async move {
            self.usage
                .recent(limit)
                .await
                .map(|entries| entries.into_iter().map(project_usage_entry).collect())
                .map_err(|_| ::usage::UsageReadError::Unavailable)
        })
    }

    fn session_usage_timeseries<'a>(
        &'a self,
        agent_id: &'a str,
        session_id: &'a str,
    ) -> ::usage::ports::UsageFuture<'a, Result<Vec<::usage::UsageEntry>, ::usage::UsageReadError>>
    {
        Box::pin(async move {
            self.usage
                .session_timeseries(agent_id, session_id)
                .await
                .map(|entries| entries.into_iter().map(project_usage_entry).collect())
                .map_err(|_| ::usage::UsageReadError::Unavailable)
        })
    }

    fn default_usage_limit(&self) -> usize {
        crate::usage::UsageProjection::default_limit()
    }

    fn max_usage_limit(&self) -> usize {
        crate::usage::UsageProjection::max_limit()
    }
}

fn project_usage_entry(entry: crate::usage::UsageEntry) -> ::usage::UsageEntry {
    ::usage::UsageEntry {
        session_id: entry.session_id().to_owned(),
        agent_id: entry.agent_id().to_owned(),
        timestamp: entry.timestamp().to_owned(),
        model: entry.model().map(str::to_owned),
        provider: entry.provider().map(str::to_owned),
        input_tokens: entry.input_tokens(),
        output_tokens: entry.output_tokens(),
        cache_read_tokens: entry.cache_read_tokens(),
        cache_write_tokens: entry.cache_write_tokens(),
        total_tokens: entry.total_tokens(),
        cost_usd: entry.cost_usd(),
    }
}
