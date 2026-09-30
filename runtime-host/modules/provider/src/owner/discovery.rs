use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use platform::call::CallId;

use crate::{ProviderAccountId, ProviderModelDiscoveryView};

const MAX_DISCOVERIES: usize = 64;
const RESULT_TTL: Duration = Duration::from_secs(10 * 60);

#[derive(Default)]
pub(crate) struct ProviderDiscoveries(Mutex<HashMap<String, Discovery>>);

pub(crate) struct DiscoveryReservation {
    discoveries: Arc<ProviderDiscoveries>,
    call_id: CallId,
    completed: bool,
}

impl DiscoveryReservation {
    pub(crate) fn try_new(
        discoveries: Arc<ProviderDiscoveries>,
        call_id: CallId,
        account_id: ProviderAccountId,
    ) -> Result<Self, ()> {
        discoveries.reserve(&call_id, account_id)?;
        Ok(Self {
            discoveries,
            call_id,
            completed: false,
        })
    }

    pub(crate) fn complete(&mut self, models: Vec<ProviderModelDiscoveryView>) -> Result<(), ()> {
        self.discoveries.complete(&self.call_id, models)?;
        self.completed = true;
        Ok(())
    }
}

impl Drop for DiscoveryReservation {
    fn drop(&mut self) {
        if !self.completed {
            self.discoveries.release(&self.call_id);
        }
    }
}

struct Discovery {
    account_id: ProviderAccountId,
    result: Option<(Instant, Vec<ProviderModelDiscoveryView>)>,
}

pub(crate) enum DiscoveryResult {
    Pending,
    Available(Vec<ProviderModelDiscoveryView>),
    Expired,
}

impl ProviderDiscoveries {
    pub(crate) fn reserve(
        &self,
        call_id: &CallId,
        account_id: ProviderAccountId,
    ) -> Result<(), ()> {
        let mut entries = self.0.lock().map_err(|_| ())?;
        entries.retain(|_, entry| {
            entry
                .result
                .as_ref()
                .is_none_or(|(finished, _)| finished.elapsed() < RESULT_TTL)
        });
        if entries.len() >= MAX_DISCOVERIES {
            return Err(());
        }
        entries.insert(
            call_id.as_str().to_owned(),
            Discovery {
                account_id,
                result: None,
            },
        );
        Ok(())
    }

    pub(crate) fn release(&self, call_id: &CallId) {
        if let Ok(mut entries) = self.0.lock() {
            entries.remove(call_id.as_str());
        }
    }

    pub(crate) fn complete(
        &self,
        call_id: &CallId,
        models: Vec<ProviderModelDiscoveryView>,
    ) -> Result<(), ()> {
        let mut entries = self.0.lock().map_err(|_| ())?;
        let entry = entries.get_mut(call_id.as_str()).ok_or(())?;
        entry.result = Some((Instant::now(), models));
        Ok(())
    }

    pub(crate) fn read(
        &self,
        call_id: &CallId,
        account_id: &ProviderAccountId,
    ) -> Result<DiscoveryResult, ()> {
        let mut entries = self.0.lock().map_err(|_| ())?;
        entries.retain(|_, entry| {
            entry
                .result
                .as_ref()
                .is_none_or(|(finished, _)| finished.elapsed() < RESULT_TTL)
        });
        Ok(
            match entries
                .get(call_id.as_str())
                .filter(|entry| &entry.account_id == account_id)
            {
                Some(Discovery {
                    result: Some((_, models)),
                    ..
                }) => DiscoveryResult::Available(models.clone()),
                Some(_) => DiscoveryResult::Pending,
                None => DiscoveryResult::Expired,
            },
        )
    }
}
