package com.manga.library.repository;

import com.manga.library.model.Job;
import java.util.List;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

@Repository
public interface JobRepository extends JpaRepository<Job, String> {
  List<Job> findByStatusOrderByCreatedAtAsc(String status);

  List<Job> findByStatusInOrderByCreatedAtAsc(List<String> statuses);

  Job findFirstByImageIdAndTypeOrderByCreatedAtDesc(java.util.UUID imageId, String type);
}
