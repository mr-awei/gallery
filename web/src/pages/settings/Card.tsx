import React from 'react';

/** 设置页通用卡片容器（从 Settings.tsx 抽出，供各区块子组件复用） */
export default function Card({
  title,
  desc,
  badge,
  children,
}: {
  title: string;
  desc?: string;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="card">
      <h4 className="section-title">
        {title}
        {badge}
      </h4>
      {desc && <div className="settings-desc">{desc}</div>}
      {children}
    </div>
  );
}
