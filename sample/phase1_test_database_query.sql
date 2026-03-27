-- Database Performance Analysis
-- Query optimization for user dashboard

SELECT 
    u.id,
    u.username,
    u.email,
    COUNT(DISTINCT p.id) as project_count,
    COUNT(DISTINCT t.id) as task_count,
    MAX(t.updated_at) as last_activity
FROM users u
LEFT JOIN projects p ON u.id = p.owner_id
LEFT JOIN tasks t ON p.id = t.project_id
WHERE u.active = true
GROUP BY u.id, u.username, u.email
ORDER BY last_activity DESC;
