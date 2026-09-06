import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.112.2';

export function readMarketBoardNotices(db: Pick<SupabaseClient, 'from'>, publicView: boolean) {
  const query = db.from('notifications').select('title,body,created_at');
  return (publicView ? query.eq('event', 'board_notice').is('recipient_id', null) : query.or('event.is.null,event.neq.board_notice_inactive'))
    .order('created_at', { ascending: false }).limit(60);
}
