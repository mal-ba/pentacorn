-- Supabase SQL Editor에서 한 번 실행해주세요.
-- 커뮤니티에 올라온 작품(제작물) 게시물이에요.

create table if not exists community_posts (
  id uuid primary key,
  title text not null,
  description text,
  image_url text not null,
  author_email text not null,
  author_name text,
  created_at timestamptz not null default now()
);

create index if not exists community_posts_created_at_idx on community_posts (created_at desc);

-- Storage에도 별도 버킷을 만들어주세요:
-- Supabase 대시보드 → Storage → New bucket → 이름: community-assets → Public bucket 체크 → Create
